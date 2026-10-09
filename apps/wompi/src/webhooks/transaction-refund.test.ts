import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import { verifySaleorWebhook } from '@licona/webhook-utils'
import { transactionRefundHandler, PLAZO_GLOBAL_MS } from './transaction-refund.js'
import { WompiHttpError } from '../lib/wompi-error.js'
import { SEPARADOR_REEMBOLSO_SIN_ID, esReferenciaSinId } from '../lib/referencia-reembolso.js'

const refundTransaction = vi.fn()
const getRefund = vi.fn()

async function correr() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const body = {
    transaction: { id: 'T', pspReference: '12084641-1791286722-99200' },
    action: { amount: 3000 },
  }
  const req = {
    rawBody: '{}',
    body,
    headers: {},
    log,
  } as unknown as FastifyRequest
  let payload: any
  const reply = {
    status: () => reply,
    send: (p: unknown) => ((payload = p), reply),
  }
  const promesa = transactionRefundHandler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync()
  await promesa
  return { payload, log }
}

const refund = (status: string, extra = {}) => ({
  id: 30954,
  transaction_id: 'x',
  status,
  amount_in_cents: 300000,
  ...extra,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(wompiClient).mockReturnValue({
    refundTransaction,
    getRefund,
  } as unknown as ReturnType<typeof wompiClient>)
})
afterEach(() => {
  vi.useRealTimers()
})

const PREFIJO_SIN_ID = /^12084641-1791286722-99200:reembolso-sin-id:[0-9a-f-]{36}$/

// El separador es compartido con la conciliación (B-1077): si cambia en un solo sitio, esto falla.
it('la referencia sin-id usa el separador compartido que reconoce la conciliación', () => {
  expect(SEPARADOR_REEMBOLSO_SIN_ID).toBe(':reembolso-sin-id:')
  expect(esReferenciaSinId(`12084641-1791286722-99200${SEPARADOR_REEMBOLSO_SIN_ID}x`)).toBe(true)
})

describe('transactionRefundHandler — POST /refunds con sondeo (B-432)', () => {
  it('crea el reembolso con el id de Wompi y el importe en centavos', async () => {
    refundTransaction.mockResolvedValue(refund('APPROVED'))
    await correr()
    expect(refundTransaction).toHaveBeenCalledWith('12084641-1791286722-99200', 300000, expect.any(AbortSignal))
  })
  it('APPROVED inmediato -> REFUND_SUCCESS con pspReference = id del refund', async () => {
    refundTransaction.mockResolvedValue(refund('APPROVED'))
    const { payload } = await correr()
    expect(payload).toEqual({
      result: 'REFUND_SUCCESS',
      amount: 3000,
      pspReference: '30954',
    })
    expect(getRefund).not.toHaveBeenCalled()
  })
  it('PENDING y luego APPROVED tras sondeo -> REFUND_SUCCESS', async () => {
    refundTransaction.mockResolvedValue(refund('PENDING'))
    getRefund.mockResolvedValueOnce(refund('PENDING')).mockResolvedValueOnce(refund('APPROVED'))
    const { payload } = await correr()
    expect(getRefund).toHaveBeenCalledTimes(2)
    expect(payload).toMatchObject({
      result: 'REFUND_SUCCESS',
      pspReference: '30954',
    })
  })
  it('PENDING persistente -> respuesta asíncrona (solo pspReference) y warn', async () => {
    refundTransaction.mockResolvedValue(refund('PENDING'))
    getRefund.mockResolvedValue(refund('PENDING'))
    const { payload, log } = await correr()
    expect(payload).toEqual({ pspReference: '30954' })
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'Reembolso pendiente en Wompi, revisar')
  })
  it('DECLINED -> REFUND_FAILURE con status_message', async () => {
    refundTransaction.mockResolvedValue(refund('PENDING'))
    getRefund.mockResolvedValue(refund('DECLINED', { status_message: 'Sin fondos' }))
    const { payload } = await correr()
    expect(payload).toMatchObject({
      result: 'REFUND_FAILURE',
      message: 'Sin fondos',
    })
  })
  it('4xx de Wompi al crear -> REFUND_FAILURE con mensaje fijo, sin el texto del error', async () => {
    refundTransaction.mockRejectedValue(new WompiHttpError('Wompi refund 422: secreto-interno', 422))
    const { payload, log } = await correr()
    expect(payload).toEqual({
      result: 'REFUND_FAILURE',
      amount: 3000,
      message: 'Wompi rechazó la solicitud de reembolso',
    })
    expect(JSON.stringify(payload)).not.toContain('secreto-interno')
    expect(log.error).toHaveBeenCalled()
  })
  it.each([
    ['AbortError', Object.assign(new Error('secreto-interno'), { name: 'AbortError' })],
    ['fetch failed', new TypeError('fetch failed secreto-interno')],
    ['5xx', new WompiHttpError('Wompi refund 503: secreto-interno', 503)],
    ['429', new WompiHttpError('Wompi refund 429: secreto-interno', 429)],
    ['408', new WompiHttpError('Wompi refund 408: secreto-interno', 408)],
  ])('%s al crear -> no final: solo pspReference único sin id, sin filtrar el error', async (_n, error) => {
    refundTransaction.mockRejectedValue(error)
    const { payload, log } = await correr()
    expect(Object.keys(payload)).toEqual(['pspReference'])
    expect(payload.pspReference).toMatch(PREFIJO_SIN_ID)
    expect(esReferenciaSinId(payload.pspReference as string)).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('secreto-interno')
    expect(log.error).toHaveBeenCalled()
  })
  it.each([401, 404])('%i al crear -> REFUND_FAILURE', async (status) => {
    refundTransaction.mockRejectedValue(new WompiHttpError(`Wompi refund ${status}: secreto-interno`, status))
    const { payload } = await correr()
    expect(payload).toMatchObject({ result: 'REFUND_FAILURE', amount: 3000 })
    expect(JSON.stringify(payload)).not.toContain('secreto-interno')
  })
  it('dos fallos sin id seguidos dan referencias distintas con el prefijo', async () => {
    refundTransaction.mockRejectedValue(new TypeError('fetch failed'))
    const a = (await correr()).payload.pspReference
    const b = (await correr()).payload.pspReference
    expect(a).toMatch(PREFIJO_SIN_ID)
    expect(b).toMatch(PREFIJO_SIN_ID)
    expect(a).not.toBe(b)
  })
  it('Wompi responde sin id al crear -> referencia única, no "undefined"', async () => {
    refundTransaction.mockResolvedValue({
      transaction_id: 'x',
      status: 'PENDING',
      amount_in_cents: 300000,
    })
    const { payload } = await correr()
    expect(payload.pspReference).toMatch(PREFIJO_SIN_ID)
    expect(getRefund).not.toHaveBeenCalled()
  })
  it('el log de error lleva el importe', async () => {
    refundTransaction.mockRejectedValue(new TypeError('fetch failed'))
    const { log } = await correr()
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ amount: 3000 }), expect.any(String))
  })
  it.each([
    ['AbortError', Object.assign(new Error('secreto-interno'), { name: 'AbortError' })],
    ['fetch failed', new TypeError('fetch failed secreto-interno')],
    ['4xx del sondeo', new WompiHttpError('Wompi getRefund 404', 404)],
  ])('%s en el sondeo tras crear -> no final con el pspReference del reembolso', async (_n, error) => {
    refundTransaction.mockResolvedValue(refund('PENDING'))
    getRefund.mockRejectedValue(error)
    const { payload, log } = await correr()
    expect(payload).toEqual({ pspReference: '30954' })
    expect(payload).not.toHaveProperty('result')
    expect(JSON.stringify(payload)).not.toContain('secreto-interno')
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ refundId: '30954' }), expect.any(String))
  })
})

/** Llamada a Wompi que se cuelga (como un fetch sin respuesta) y solo termina si el plazo la aborta. */
const ultimaSenal = (args: unknown[]) => args[args.length - 1] as AbortSignal
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

describe('transactionRefundHandler — plazo global bajo los 18 s de Saleor (B-1078)', () => {
  it('el plazo global es de 15 s, con margen bajo los 18 s de Saleor', () => {
    expect(PLAZO_GLOBAL_MS).toBe(15_000)
  })
  it('crear lento (3 s) + sondeo colgado -> responde dentro del plazo, sin result y con el id', async () => {
    refundTransaction.mockImplementation(tarda(3000, refund('PENDING')))
    getRefund.mockImplementation(colgada)
    const inicio = Date.now()
    const { payload } = await correr()
    expect(Date.now() - inicio).toBeLessThanOrEqual(PLAZO_GLOBAL_MS)
    expect(payload).toEqual({ pspReference: '30954' })
    expect(payload).not.toHaveProperty('result')
  })
  it('el plazo se agota durante la creación -> sin result y con referencia sin-id', async () => {
    refundTransaction.mockImplementation(colgada)
    const inicio = Date.now()
    const { payload } = await correr()
    expect(Date.now() - inicio).toBe(PLAZO_GLOBAL_MS)
    expect(payload).not.toHaveProperty('result')
    expect(payload.pspReference).toMatch(PREFIJO_SIN_ID)
    expect(getRefund).not.toHaveBeenCalled()
  })
  it('tras crear queda menos de un intervalo de plazo -> se omite espera y sondeo, respuesta no final con el id', async () => {
    refundTransaction.mockImplementation(tarda(PLAZO_GLOBAL_MS - 1000, refund('PENDING')))
    const { payload } = await correr()
    expect(getRefund).not.toHaveBeenCalled()
    expect(payload).toEqual({ pspReference: '30954' })
  })
  it('todas las llamadas reciben la misma señal de plazo', async () => {
    refundTransaction.mockResolvedValue(refund('PENDING'))
    getRefund.mockResolvedValue(refund('APPROVED'))
    await correr()
    expect(getRefund).toHaveBeenCalledWith('30954', refundTransaction.mock.calls[0][2])
  })
  it('camino rápido: APPROVED inmediato sigue dando REFUND_SUCCESS', async () => {
    refundTransaction.mockResolvedValue(refund('APPROVED'))
    const { payload } = await correr()
    expect(payload).toEqual({
      result: 'REFUND_SUCCESS',
      amount: 3000,
      pspReference: '30954',
    })
  })
  it('un 4xx al crear sigue dando REFUND_FAILURE', async () => {
    refundTransaction.mockRejectedValue(new WompiHttpError('Wompi refund 422', 422))
    const { payload } = await correr()
    expect(payload).toMatchObject({ result: 'REFUND_FAILURE', amount: 3000 })
  })
  it('la verificación de firma tarda 4 s -> el plazo cubre también esa espera (restan 11 s) y responde antes de 15 s', async () => {
    vi.mocked(verifySaleorWebhook).mockImplementationOnce(() => new Promise((res) => setTimeout(res, 4000)) as never)
    refundTransaction.mockImplementation(colgada)
    const inicio = Date.now()
    const { payload } = await correr()
    expect(Date.now() - inicio).toBe(PLAZO_GLOBAL_MS)
    expect(payload).not.toHaveProperty('result')
    expect(payload.pspReference).toMatch(PREFIJO_SIN_ID)
  })
  it('la verificación consume todo el plazo -> no se llama a Wompi y responde no final sin-id', async () => {
    vi.mocked(verifySaleorWebhook).mockImplementationOnce(
      () => new Promise((res) => setTimeout(res, PLAZO_GLOBAL_MS + 500)) as never,
    )
    const { payload } = await correr()
    expect(refundTransaction).not.toHaveBeenCalled()
    expect(payload).not.toHaveProperty('result')
    expect(payload.pspReference).toMatch(PREFIJO_SIN_ID)
  })
  it('un aborto por plazo se registra como warn, no como error', async () => {
    refundTransaction.mockImplementation(colgada)
    const { log } = await correr()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ amount: 3000 }), expect.any(String))
  })
})
