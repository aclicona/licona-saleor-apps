import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../lib/saleor-client.js', () => ({
  reportTransactionEvent: vi.fn(),
  obtenerEventosTransaccion: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { obtenerEventosTransaccion, reportTransactionEvent } from '../lib/saleor-client.js'
import { wompiClient } from '../lib/wompi-client.js'
import { WompiHttpError } from '../lib/wompi-error.js'
import { wompiIncomingHandler } from './wompi-incoming.js'
import { cierreDeEstadoReembolso } from './refund-updated.js'

const reportMock = vi.mocked(reportTransactionEvent)
const eventosMock = vi.mocked(obtenerEventosTransaccion)
const wompiClientMock = vi.mocked(wompiClient)
const getRefundMock = vi.fn()
const getTransactionMock = vi.fn()

const SECRET = 'secreto-de-eventos-de-prueba'
const REFERENCIA_SALEOR = 'VHJhbnNhY3Rpb25JdGVtOmEyMGVkNTc2LTNkOGMtNDliMi1iZGUzLTgwYzA3NmExNzUzYg=='
const REFUND_ID = 'COa7Bk9m1'
const IMPORTE_CENTS = 5_000_000

const ahoraUnix = () => Math.floor(Date.now() / 1000)

function refundDe(status: string) {
  return { id: REFUND_ID, status, amount_in_cents: IMPORTE_CENTS, transaction_id: 'wompi-txn-1' }
}

/** Firma independiente (SHA-256 de valores + timestamp + secreto), como en wompi-incoming.test.ts. */
function peticion(status: string, opts: { secret?: string; timestamp?: number; checksum?: string } = {}) {
  const timestamp = opts.timestamp ?? ahoraUnix()
  const data = { refund: refundDe(status) }
  const checksum =
    opts.checksum ??
    createHash('sha256')
      .update(`${REFUND_ID}${status}${IMPORTE_CENTS}${timestamp}${opts.secret ?? SECRET}`)
      .digest('hex')
      .toUpperCase()
  const body = { event: 'refund.updated', data, timestamp, signature: { properties: ['refund.id', 'refund.status', 'refund.amount_in_cents'], checksum } }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return { req: { body, headers: { 'x-event-checksum': checksum }, log } as unknown as FastifyRequest, log }
}

function crearReply() {
  const captura: { status: number } = { status: 200 }
  const reply = {
    status(c: number) { captura.status = c; return reply },
    send() { return reply },
  }
  return { reply: reply as unknown as FastifyReply, captura }
}

async function enviar(status: string, opts?: Parameters<typeof peticion>[1]) {
  const { req, log } = peticion(status, opts)
  const { reply, captura } = crearReply()
  await wompiIncomingHandler(req, reply)
  return { status: captura.status, log }
}

const REQUEST = { type: 'REFUND_REQUEST', pspReference: REFUND_ID, createdAt: '2026-11-25T10:00:00Z', amount: 50000 }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WOMPI_EVENTS_SECRET = SECRET
  getRefundMock.mockImplementation(async () => ({ ...refundDe(realStatus) }))
  getTransactionMock.mockResolvedValue({ id: 'wompi-txn-1', reference: REFERENCIA_SALEOR })
  wompiClientMock.mockReturnValue({ getRefund: getRefundMock, getTransaction: getTransactionMock } as unknown as ReturnType<typeof wompiClient>)
  eventosMock.mockResolvedValue([REQUEST])
  reportMock.mockResolvedValue({ alreadyProcessed: false, transactionId: 'x', errors: [] })
  realStatus = 'APPROVED'
})
afterEach(() => { delete process.env.WOMPI_EVENTS_SECRET })

let realStatus = 'APPROVED'

describe('refund.updated — firma y mapeo', () => {
  it('rechaza con 401 una firma inválida sin tocar Wompi ni Saleor', async () => {
    const { status } = await enviar('APPROVED', { checksum: 'A'.repeat(64) })
    expect(status).toBe(401)
    expect(getRefundMock).not.toHaveBeenCalled()
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('rechaza con 401 una firma calculada con otro secreto', async () => {
    const { status } = await enviar('APPROVED', { secret: 'otro' })
    expect(status).toBe(401)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('APPROVED reporta REFUND_SUCCESS con el id del reembolso como pspReference e importe en COP', async () => {
    const { status } = await enviar('APPROVED')
    expect(status).toBe(200)
    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(reportMock.mock.calls[0]![0]).toMatchObject({ type: 'REFUND_SUCCESS', pspReference: REFUND_ID, amount: 50000 })
  })

  it.each(['DECLINED', 'ERROR', 'CANCELLED'])('%s reporta REFUND_FAILURE', async (estado) => {
    realStatus = estado
    const { status } = await enviar(estado)
    expect(status).toBe(200)
    expect(reportMock.mock.calls[0]![0]).toMatchObject({ type: 'REFUND_FAILURE', pspReference: REFUND_ID })
  })

  it.each(['PENDING', 'PROCESSING', 'RARO'])('%s no cambia nada y no consulta ni reporta', async (estado) => {
    const { status } = await enviar(estado)
    expect(status).toBe(200)
    expect(getRefundMock).not.toHaveBeenCalled()
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('cierreDeEstadoReembolso es la tabla de estados', () => {
    expect(cierreDeEstadoReembolso('APPROVED')).toBe('REFUND_SUCCESS')
    expect(cierreDeEstadoReembolso('VOIDED')).toBeUndefined()
  })
})

describe('refund.updated — idempotencia y seguridad contra doble contabilización', () => {
  it('evento repetido: si Saleor ya tiene REFUND_SUCCESS con ese psp no vuelve a reportar', async () => {
    eventosMock.mockResolvedValue([REQUEST, { ...REQUEST, type: 'REFUND_SUCCESS' }])
    const { status } = await enviar('APPROVED')
    expect(status).toBe(200)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('no contradice un cierre previo: FAILURE tras SUCCESS no se reporta', async () => {
    realStatus = 'DECLINED'
    eventosMock.mockResolvedValue([REQUEST, { ...REQUEST, type: 'REFUND_SUCCESS' }])
    await enviar('DECLINED')
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('reembolso desconocido para Saleor (sin REFUND_REQUEST con ese psp, p. ej. request sin-id) lo deja a la conciliación', async () => {
    eventosMock.mockResolvedValue([{ ...REQUEST, pspReference: 'wompi-txn-1:reembolso-sin-id:abc' }])
    const { status } = await enviar('APPROVED')
    expect(status).toBe(200)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('alreadyProcessed de Saleor es un camino sano (200)', async () => {
    reportMock.mockResolvedValue({ alreadyProcessed: true, transactionId: 'x', errors: [] })
    const { status } = await enviar('APPROVED')
    expect(status).toBe(200)
  })

  it('transacción inexistente en Saleor: 200 sin reportar', async () => {
    eventosMock.mockResolvedValue(null)
    const { status } = await enviar('APPROVED')
    expect(status).toBe(200)
    expect(reportMock).not.toHaveBeenCalled()
  })
})

describe('refund.updated — contraste con Wompi y fallos', () => {
  it('rechaza con 401 si el reembolso real tiene otro estado', async () => {
    realStatus = 'DECLINED'
    const { status } = await enviar('APPROVED')
    expect(status).toBe(401)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('404 de Wompi: 401 sin reportar', async () => {
    getRefundMock.mockRejectedValue(new WompiHttpError('x', 404))
    expect((await enviar('APPROVED')).status).toBe(401)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('Wompi caído: 500 para que reintente', async () => {
    getRefundMock.mockRejectedValue(new WompiHttpError('x', 503))
    expect((await enviar('APPROVED')).status).toBe(500)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('Saleor caído: 500 para que Wompi reintente', async () => {
    reportMock.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 503, errors: [] } }))
    expect((await enviar('APPROVED')).status).toBe(500)
  })

  it('evento fuera de la ventana de frescura: 401', async () => {
    const viejo = ahoraUnix() - 100 * 3600
    expect((await enviar('APPROVED', { timestamp: viejo })).status).toBe(401)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('error de negocio de Saleor: 200 y log de error (no converge reintentando)', async () => {
    reportMock.mockResolvedValue({ alreadyProcessed: false, transactionId: null, errors: [{ field: null, message: null, code: 'INCORRECT_DETAILS' }] })
    const { status, log } = await enviar('APPROVED')
    expect(status).toBe(200)
    expect(log.fatal).toHaveBeenCalled()
  })
})
