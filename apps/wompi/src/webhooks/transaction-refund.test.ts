import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import { transactionRefundHandler } from './transaction-refund.js'
import { WompiHttpError } from '../lib/wompi-error.js'

const refundTransaction = vi.fn()
const getRefund = vi.fn()

async function correr() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const body = { transaction: { id: 'T', pspReference: '12084641-1791286722-99200' }, action: { amount: 3000 } }
  const req = { rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest
  let payload: any
  const reply = { status: () => reply, send: (p: unknown) => ((payload = p), reply) }
  const promesa = transactionRefundHandler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync()
  await promesa
  return { payload, log }
}

const refund = (status: string, extra = {}) => ({ id: 30954, transaction_id: 'x', status, amount_in_cents: 300000, ...extra })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(wompiClient).mockReturnValue({ refundTransaction, getRefund } as unknown as ReturnType<typeof wompiClient>)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('transactionRefundHandler — POST /refunds con sondeo (B-432)', () => {
  it('crea el reembolso con el id de Wompi y el importe en centavos', async () => {
    refundTransaction.mockResolvedValue(refund('APPROVED'))
    await correr()
    expect(refundTransaction).toHaveBeenCalledWith('12084641-1791286722-99200', 300000)
  })
  it('APPROVED inmediato -> REFUND_SUCCESS con pspReference = id del refund', async () => {
    refundTransaction.mockResolvedValue(refund('APPROVED'))
    const { payload } = await correr()
    expect(payload).toEqual({ result: 'REFUND_SUCCESS', amount: 3000, pspReference: '30954' })
    expect(getRefund).not.toHaveBeenCalled()
  })
  it('PENDING y luego APPROVED tras sondeo -> REFUND_SUCCESS', async () => {
    refundTransaction.mockResolvedValue(refund('PENDING'))
    getRefund.mockResolvedValueOnce(refund('PENDING')).mockResolvedValueOnce(refund('APPROVED'))
    const { payload } = await correr()
    expect(getRefund).toHaveBeenCalledTimes(2)
    expect(payload).toMatchObject({ result: 'REFUND_SUCCESS', pspReference: '30954' })
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
    expect(payload).toMatchObject({ result: 'REFUND_FAILURE', message: 'Sin fondos' })
  })
  it('4xx de Wompi al crear -> REFUND_FAILURE con mensaje fijo, sin el texto del error', async () => {
    refundTransaction.mockRejectedValue(new WompiHttpError('Wompi refund 422: secreto-interno', 422))
    const { payload, log } = await correr()
    expect(payload).toEqual({ result: 'REFUND_FAILURE', amount: 3000, message: 'Wompi rechazó la solicitud de reembolso' })
    expect(JSON.stringify(payload)).not.toContain('secreto-interno')
    expect(log.error).toHaveBeenCalled()
  })
  it.each([
    ['AbortError', Object.assign(new Error('secreto-interno'), { name: 'AbortError' })],
    ['fetch failed', new TypeError('fetch failed secreto-interno')],
    ['5xx', new WompiHttpError('Wompi refund 503: secreto-interno', 503)],
    ['429', new WompiHttpError('Wompi refund 429: secreto-interno', 429)],
  ])('%s al crear -> no final: solo pspReference de la transacción, sin filtrar el error', async (_n, error) => {
    refundTransaction.mockRejectedValue(error)
    const { payload, log } = await correr()
    expect(payload).toEqual({ pspReference: '12084641-1791286722-99200' })
    expect(JSON.stringify(payload)).not.toContain('secreto-interno')
    expect(log.error).toHaveBeenCalled()
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
