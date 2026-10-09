import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { verifySaleorWebhook } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { WompiHttpError } from '../lib/wompi-error.js'
import { PLAZO_GLOBAL_MS } from '../lib/plazo.js'
import { transactionInitializeHandler } from './transaction-initialize.js'

// B-1060: un fallo de transporte al crear la transacción NO es un rechazo (pudo crearse en Wompi).
// Ver «Inicio: fallo de transporte ≠ CHARGE_FAILURE» en docs/wompi-estados.md.

const TEXTO_ERROR = 'secreto-interno-xyz'
const getAcceptanceToken = vi.fn()
const createTransaction = vi.fn()

const abortError = () => Object.assign(new Error(TEXTO_ERROR), { name: 'AbortError' })
const timeoutError = () => Object.assign(new Error(TEXTO_ERROR), { name: 'TimeoutError' })
const fetchFailed = () => new TypeError(`fetch failed ${TEXTO_ERROR}`)
const http = (status: number) => () => new WompiHttpError(`Wompi ${status}: ${TEXTO_ERROR}`, status)

const ultimaSenal = (args: unknown[]) => args[args.length - 1] as AbortSignal
/** Llamada a Wompi que se cuelga y solo termina si el plazo la aborta. */
const colgada = (...args: unknown[]) => {
  const signal = ultimaSenal(args)
  return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason)))
}
/** Llamada que tarda `ms` y luego resuelve, salvo que el plazo la aborte antes. */
const tarda =
  (ms: number, valor: unknown) =>
  (...args: unknown[]) => {
    const signal = ultimaSenal(args)
    return new Promise((res, rej) => {
      const t = setTimeout(() => res(valor), ms)
      signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)))
    })
  }

async function correr() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const cuerpo = {
    transaction: { id: 'VHJhbnNhY3Rpb25JdGVtOjE=', pspReference: '' },
    action: { amount: 120_000, currency: 'COP' },
    sourceObject: { email: 'cliente@example.com' },
    data: { method: 'NEQUI', phone_number: '3001234567' },
  }
  const req = { rawBody: '{}', body: cuerpo, headers: {}, log } as unknown as FastifyRequest
  let payload: any
  const reply = { status: () => reply, send: (p: unknown) => ((payload = p), reply) }
  const t0 = Date.now()
  const promesa = transactionInitializeHandler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync()
  await promesa
  return { payload, log, transcurrido: Date.now() - t0 }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(verifySaleorWebhook).mockResolvedValue(undefined as never)
  getAcceptanceToken.mockResolvedValue('tok')
  createTransaction.mockResolvedValue({ id: 'w1', redirect_url: 'https://checkout.wompi.co/l/x' })
  vi.mocked(wompiClient).mockReturnValue({ getAcceptanceToken, createTransaction } as unknown as ReturnType<typeof wompiClient>)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('transaction-initialize — fallos de transporte (B-1060)', () => {
  it.each([
    ['AbortError', abortError],
    ['fetch failed', fetchFailed],
    ['503', http(503)],
  ])('getAcceptanceToken lanza %s -> CHARGE_FAILURE con mensaje fijo, sin pspReference ni el texto del error', async (_n, crear) => {
    getAcceptanceToken.mockRejectedValue(crear())
    const { payload } = await correr()
    expect(payload).toEqual({ result: 'CHARGE_FAILURE', amount: 120_000, message: 'No se pudo iniciar el pago con Wompi' })
    expect(JSON.stringify(payload)).not.toContain(TEXTO_ERROR)
    expect(createTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['AbortError', abortError],
    ['TimeoutError', timeoutError],
    ['fetch failed', fetchFailed],
    ['503', http(503)],
    ['429', http(429)],
    ['408', http(408)],
  ])('createTransaction lanza %s -> CHARGE_ACTION_REQUIRED sin pspReference, con mensaje fijo', async (_n, crear) => {
    createTransaction.mockRejectedValue(crear())
    const { payload } = await correr()
    expect(payload).toEqual({
      result: 'CHARGE_ACTION_REQUIRED',
      amount: 120_000,
      actions: [],
      message: 'Estado en Wompi desconocido por un fallo transitorio; se resolverá por conciliación',
    })
    expect(payload).not.toHaveProperty('pspReference')
    expect(JSON.stringify(payload)).not.toContain(TEXTO_ERROR)
  })

  it.each([422, 400, 401])('createTransaction %i -> CHARGE_FAILURE con mensaje fijo', async (status) => {
    createTransaction.mockRejectedValue(http(status)())
    const { payload } = await correr()
    expect(payload).toEqual({ result: 'CHARGE_FAILURE', amount: 120_000, message: 'Wompi rechazó la transacción' })
    expect(JSON.stringify(payload)).not.toContain(TEXTO_ERROR)
  })

  it('ambas llamadas reciben la misma AbortSignal', async () => {
    await correr()
    const s1 = getAcceptanceToken.mock.calls[0][0]
    const s2 = createTransaction.mock.calls[0][1]
    expect(s1).toBeInstanceOf(AbortSignal)
    expect(s2).toBe(s1)
  })

  it('createTransaction colgada -> responde a los 15 s exactos con CHARGE_ACTION_REQUIRED y log.warn, no error', async () => {
    createTransaction.mockImplementation(colgada)
    const { payload, log, transcurrido } = await correr()
    expect(transcurrido).toBe(PLAZO_GLOBAL_MS)
    expect(payload.result).toBe('CHARGE_ACTION_REQUIRED')
    expect(payload).not.toHaveProperty('pspReference')
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ metodo: 'NEQUI' }), expect.any(String))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('token tarda 10 s + crear colgada -> responde a 15 s, no a 25', async () => {
    getAcceptanceToken.mockImplementation(tarda(10_000, 'tok'))
    createTransaction.mockImplementation(colgada)
    const { payload, transcurrido } = await correr()
    expect(transcurrido).toBe(PLAZO_GLOBAL_MS)
    expect(payload.result).toBe('CHARGE_ACTION_REQUIRED')
  })

  it('la firma tarda 4 s -> el plazo cuenta desde la llegada (responde a 15 s)', async () => {
    vi.mocked(verifySaleorWebhook).mockImplementation(() => new Promise((res) => setTimeout(res, 4_000)) as never)
    createTransaction.mockImplementation(colgada)
    const { payload, transcurrido } = await correr()
    expect(transcurrido).toBe(PLAZO_GLOBAL_MS)
    expect(payload.result).toBe('CHARGE_ACTION_REQUIRED')
  })

  it('camino feliz: CHARGE_ACTION_REQUIRED con pspReference y data.redirectUrl', async () => {
    const { payload } = await correr()
    expect(payload).toMatchObject({
      result: 'CHARGE_ACTION_REQUIRED',
      pspReference: 'w1',
      data: { redirectUrl: 'https://checkout.wompi.co/l/x', wompiTransactionId: 'w1' },
    })
  })
})
