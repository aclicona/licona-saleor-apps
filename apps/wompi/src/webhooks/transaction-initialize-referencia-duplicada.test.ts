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
import { referenciaParaWompi } from '../lib/referencia.js'
import { transactionInitializeHandler } from './transaction-initialize.js'

// B-1095: el reintento tras un inicio ambiguo recibe 422 «referencia duplicada» (la huérfana existe). Se busca la
// transacción por `reference` en vez de cerrar como CHARGE_FAILURE. Ver docs/wompi-estados.md.

const TEXTO_ERROR = 'secreto-interno-xyz'
const getAcceptanceToken = vi.fn()
const createTransaction = vi.fn()
const findTransactionsByReference = vi.fn()

const fetchFailed = () => new TypeError(`fetch failed ${TEXTO_ERROR}`)

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

const REF_ESPERADA = referenciaParaWompi('VHJhbnNhY3Rpb25JdGVtOjE=')
const duplicada = () =>
  new WompiHttpError(`Wompi 422: ${TEXTO_ERROR}`, 422, {
    error: { type: 'INPUT_VALIDATION_ERROR', messages: { reference: ['La referencia ya ha sido usada'] } },
  })
const otro422 = () =>
  new WompiHttpError(`Wompi 422: ${TEXTO_ERROR}`, 422, {
    error: { type: 'INPUT_VALIDATION_ERROR', messages: { payment_method: { token: ['El token es inválido'] } } },
  })
const SIN_PSP = {
  result: 'CHARGE_ACTION_REQUIRED',
  amount: 120_000,
  actions: [],
  message: 'Estado en Wompi desconocido por un fallo transitorio; se resolverá por conciliación',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(verifySaleorWebhook).mockResolvedValue(undefined as never)
  getAcceptanceToken.mockResolvedValue('tok')
  createTransaction.mockRejectedValue(duplicada())
  findTransactionsByReference.mockResolvedValue([])
  vi.mocked(wompiClient).mockReturnValue({
    getAcceptanceToken,
    createTransaction,
    findTransactionsByReference,
  } as unknown as ReturnType<typeof wompiClient>)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('transaction-initialize — 422 «referencia duplicada» (B-1095)', () => {
  it('la huérfana PENDING existe -> CHARGE_ACTION_REQUIRED con su pspReference, nunca CHARGE_FAILURE', async () => {
    findTransactionsByReference.mockResolvedValue([{ id: 'w-huerfana', status: 'PENDING', reference: REF_ESPERADA, redirect_url: 'https://r.co/x' }])
    const { payload } = await correr()
    expect(payload).toMatchObject({
      result: 'CHARGE_ACTION_REQUIRED',
      amount: 120_000,
      pspReference: 'w-huerfana',
      data: { redirectUrl: 'https://r.co/x', wompiTransactionId: 'w-huerfana' },
    })
    expect(findTransactionsByReference.mock.calls[0][0]).toBe(REF_ESPERADA)
    expect(JSON.stringify(payload)).not.toContain(TEXTO_ERROR)
  })

  it('la huérfana ya está APPROVED -> CHARGE_SUCCESS con pspReference y acción REFUND', async () => {
    findTransactionsByReference.mockResolvedValue([{ id: 'w-ok', status: 'APPROVED', reference: REF_ESPERADA }])
    const { payload } = await correr()
    expect(payload).toMatchObject({ result: 'CHARGE_SUCCESS', amount: 120_000, pspReference: 'w-ok', actions: ['REFUND'] })
  })

  it('la huérfana quedó DECLINED -> CHARGE_FAILURE con su pspReference (el estado es cierto, no un fallo del cliente)', async () => {
    findTransactionsByReference.mockResolvedValue([{ id: 'w-no', status: 'DECLINED', reference: REF_ESPERADA }])
    const { payload } = await correr()
    expect(payload).toMatchObject({ result: 'CHARGE_FAILURE', pspReference: 'w-no' })
  })

  it('Wompi ignora el filtro y devuelve ajenas: no se mapea ninguna -> ACTION_REQUIRED sin pspReference', async () => {
    // El cliente ya filtra por reference exacta; aquí el doble devuelve lo que entregaría un cliente sin filtro.
    findTransactionsByReference.mockResolvedValue([
      { id: 'ajena-1', status: 'APPROVED', reference: 'otro-comprador-1' },
      { id: 'ajena-2', status: 'APPROVED', reference: 'otro-comprador-2' },
    ])
    const { payload } = await correr()
    expect(payload).toEqual(SIN_PSP)
    expect(payload).not.toHaveProperty('pspReference')
  })

  it('varias coincidencias exactas (no debería pasar) -> no se elige: ACTION_REQUIRED sin pspReference', async () => {
    findTransactionsByReference.mockResolvedValue([
      { id: 'a', status: 'APPROVED', reference: REF_ESPERADA },
      { id: 'b', status: 'PENDING', reference: REF_ESPERADA },
    ])
    const { payload } = await correr()
    expect(payload).toEqual(SIN_PSP)
  })

  it.each([
    ['fetch failed', fetchFailed],
    ['503', () => new Error('Wompi listado 503')],
  ])('la búsqueda falla (%s) -> ACTION_REQUIRED sin pspReference, no FAILURE', async (_n, crear) => {
    findTransactionsByReference.mockRejectedValue(crear())
    const { payload, log } = await correr()
    expect(payload).toEqual(SIN_PSP)
    expect(log.error).toHaveBeenCalled()
  })

  it('la búsqueda se cuelga -> responde a los 15 s con ACTION_REQUIRED sin pspReference', async () => {
    findTransactionsByReference.mockImplementation(colgada)
    const { payload, transcurrido } = await correr()
    expect(transcurrido).toBe(PLAZO_GLOBAL_MS)
    expect(payload).toEqual(SIN_PSP)
  })

  it('el plazo ya se agotó antes del 422 -> ni se busca; ACTION_REQUIRED sin pspReference', async () => {
    createTransaction.mockImplementation(async (...args: unknown[]) => {
      await tarda(PLAZO_GLOBAL_MS, null)(...args).catch(() => undefined)
      throw duplicada()
    })
    const { payload } = await correr()
    expect(findTransactionsByReference).not.toHaveBeenCalled()
    expect(payload).toEqual(SIN_PSP)
  })

  it('la búsqueda recibe la señal del plazo global', async () => {
    await correr()
    expect(findTransactionsByReference.mock.calls[0][1]).toBe(createTransaction.mock.calls[0][1])
  })

  it('422 por otro motivo (token de tarjeta inválido) -> sigue CHARGE_FAILURE y no busca', async () => {
    createTransaction.mockRejectedValue(otro422())
    const { payload } = await correr()
    expect(payload).toEqual({ result: 'CHARGE_FAILURE', amount: 120_000, message: 'Wompi rechazó la transacción' })
    expect(findTransactionsByReference).not.toHaveBeenCalled()
  })

  it('422 sin cuerpo interpretable -> sigue CHARGE_FAILURE', async () => {
    createTransaction.mockRejectedValue(new WompiHttpError('Wompi 422', 422))
    const { payload } = await correr()
    expect(payload.result).toBe('CHARGE_FAILURE')
    expect(findTransactionsByReference).not.toHaveBeenCalled()
  })

  it('400 con el mismo cuerpo de referencia -> sigue CHARGE_FAILURE (solo el 422 cuenta)', async () => {
    createTransaction.mockRejectedValue(new WompiHttpError('Wompi 400', 400, { error: { messages: { reference: ['x'] } } }))
    const { payload } = await correr()
    expect(payload.result).toBe('CHARGE_FAILURE')
  })
})

describe('transaction-initialize — estado desconocido con plazo disponible (B-1095)', () => {
  it('fetch failed al crear y la transacción sí existe -> responde con su pspReference', async () => {
    createTransaction.mockRejectedValue(fetchFailed())
    findTransactionsByReference.mockResolvedValue([{ id: 'w-creada', status: 'PENDING', reference: REF_ESPERADA }])
    const { payload } = await correr()
    expect(payload).toMatchObject({ result: 'CHARGE_ACTION_REQUIRED', pspReference: 'w-creada' })
  })

  it('timeout al crear (sin plazo) -> no se busca', async () => {
    createTransaction.mockImplementation(colgada)
    const { payload } = await correr()
    expect(findTransactionsByReference).not.toHaveBeenCalled()
    expect(payload).toEqual(SIN_PSP)
  })
})
