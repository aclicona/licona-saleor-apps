import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Contrato de respuestas síncronas (B-1303).
 *
 * Saleor valida lo que esta App le devuelve con esquemas pydantic del fork
 * (`saleor/webhook/response_schemas/transaction.py`). Si una respuesta no encaja, Saleor la
 * DESCARTA y nadie se entera: B-1089 añadió `actions: ['REFUND']` y solo se comprobó leyendo el
 * esquema a mano. Aquí cada respuesta representativa se congela en `contrato-respuestas/*.json`;
 * el validador `scripts/contrato-respuestas/validar.py` (repo raíz de ecommerce) pasa esos
 * archivos por los esquemas reales del fork. Un cambio en un handler cambia el JSON y este test
 * falla hasta que se revise (y se regenere con `vitest -u`) el contrato.
 */

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))
// Único valor aleatorio en una respuesta: la referencia sin-id del reembolso desconocido.
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}))

import { wompiClient } from '../lib/wompi-client.js'
import { WompiHttpError } from '../lib/wompi-error.js'
import { paymentGatewayInitializeHandler } from './payment-gateway-initialize.js'
import { transactionCancelHandler } from './transaction-cancel.js'
import { transactionChargeHandler } from './transaction-charge.js'
import { transactionInitializeHandler } from './transaction-initialize.js'
import { transactionProcessHandler } from './transaction-process.js'
import { transactionRefundHandler } from './transaction-refund.js'

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
type Cliente = Record<string, unknown>

const DIR_FIXTURES = fileURLToPath(new URL('../../contrato-respuestas/', import.meta.url))
const PSP = '12084641-1791286722-99200'
const TRANSACCION = { id: 'VHJhbnNhY3Rpb25JdGVtOjE=', pspReference: PSP }
const ACCION = { amount: 3000 }
const INICIO = { transaction: { id: TRANSACCION.id, pspReference: '' }, action: { amount: 120_000, currency: 'COP' }, sourceObject: { email: 'cliente@example.com' } }

const rechazo = (status: number) => new WompiHttpError('detalle-interno', status)
const txnWompi = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'wompi-txn-12345',
  status,
  reference: TRANSACCION.id,
  amount_in_cents: 12_000_000,
  currency: 'COP',
  redirect_url: 'https://checkout.wompi.co/l/abc123',
  ...extra,
})
const reembolso = (status: string, extra: Record<string, unknown> = {}) => ({ id: 30954, status, ...extra })
const inicioBase: Cliente = { getAcceptanceToken: () => Promise.resolve('acceptance-token'), createTransaction: () => Promise.resolve(txnWompi('PENDING')) }

interface Caso {
  evento: string
  caso: string
  handler: Handler
  body: unknown
  cliente: Cliente
}

const CASOS: Caso[] = [
  { evento: 'PAYMENT_GATEWAY_INITIALIZE_SESSION', caso: 'exito', handler: paymentGatewayInitializeHandler, body: {}, cliente: { getPublicKey: () => 'pub_test_clave' } },

  { evento: 'TRANSACTION_INITIALIZE_SESSION', caso: 'accion_requerida', handler: transactionInitializeHandler, body: INICIO, cliente: inicioBase },
  { evento: 'TRANSACTION_INITIALIZE_SESSION', caso: 'fallo_moneda', handler: transactionInitializeHandler, body: { ...INICIO, action: { amount: 120_000, currency: 'USD' } }, cliente: inicioBase },
  { evento: 'TRANSACTION_INITIALIZE_SESSION', caso: 'fallo_sin_token', handler: transactionInitializeHandler, body: INICIO, cliente: { ...inicioBase, getAcceptanceToken: () => Promise.reject(new Error('red')) } },
  { evento: 'TRANSACTION_INITIALIZE_SESSION', caso: 'fallo_rechazo', handler: transactionInitializeHandler, body: INICIO, cliente: { ...inicioBase, createTransaction: () => Promise.reject(rechazo(422)) } },
  {
    evento: 'TRANSACTION_INITIALIZE_SESSION',
    caso: 'desconocido_sin_psp',
    handler: transactionInitializeHandler,
    body: INICIO,
    cliente: { ...inicioBase, createTransaction: () => Promise.reject(rechazo(503)), findTransactionsByReference: () => Promise.resolve([]) },
  },
  {
    evento: 'TRANSACTION_INITIALIZE_SESSION',
    caso: 'localizada_aprobada',
    handler: transactionInitializeHandler,
    body: INICIO,
    cliente: { ...inicioBase, createTransaction: () => Promise.reject(rechazo(503)), findTransactionsByReference: () => Promise.resolve([txnWompi('APPROVED')]) },
  },

  { evento: 'TRANSACTION_PROCESS_SESSION', caso: 'exito', handler: transactionProcessHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { getTransaction: () => Promise.resolve(txnWompi('APPROVED')) } },
  { evento: 'TRANSACTION_PROCESS_SESSION', caso: 'fallo', handler: transactionProcessHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { getTransaction: () => Promise.resolve(txnWompi('DECLINED')) } },
  { evento: 'TRANSACTION_PROCESS_SESSION', caso: 'pendiente', handler: transactionProcessHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { getTransaction: () => Promise.resolve(txnWompi('PENDING')) } },
  { evento: 'TRANSACTION_PROCESS_SESSION', caso: 'fallo_sin_psp', handler: transactionProcessHandler, body: { transaction: { ...TRANSACCION, pspReference: '' }, action: ACCION }, cliente: {} },
  { evento: 'TRANSACTION_PROCESS_SESSION', caso: 'desconocido', handler: transactionProcessHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { getTransaction: () => Promise.reject(rechazo(503)) } },

  { evento: 'TRANSACTION_CHARGE_REQUESTED', caso: 'exito', handler: transactionChargeHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: {} },

  { evento: 'TRANSACTION_REFUND_REQUESTED', caso: 'exito', handler: transactionRefundHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { refundTransaction: () => Promise.resolve(reembolso('APPROVED')) } },
  { evento: 'TRANSACTION_REFUND_REQUESTED', caso: 'fallo_rechazo', handler: transactionRefundHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { refundTransaction: () => Promise.reject(rechazo(422)) } },
  { evento: 'TRANSACTION_REFUND_REQUESTED', caso: 'fallo_estado', handler: transactionRefundHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { refundTransaction: () => Promise.resolve(reembolso('DECLINED', { status_message: 'Saldo insuficiente' })) } },
  { evento: 'TRANSACTION_REFUND_REQUESTED', caso: 'fallo_sin_psp', handler: transactionRefundHandler, body: { transaction: { ...TRANSACCION, pspReference: '' }, action: ACCION }, cliente: {} },
  { evento: 'TRANSACTION_REFUND_REQUESTED', caso: 'asincrono_pendiente', handler: transactionRefundHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { refundTransaction: () => Promise.resolve(reembolso('PENDING')), getRefund: () => Promise.resolve(reembolso('PENDING')) } },
  { evento: 'TRANSACTION_REFUND_REQUESTED', caso: 'asincrono_desconocido', handler: transactionRefundHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { refundTransaction: () => Promise.reject(rechazo(503)) } },

  { evento: 'TRANSACTION_CANCELATION_REQUESTED', caso: 'exito', handler: transactionCancelHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { voidTransaction: () => Promise.resolve({}) } },
  { evento: 'TRANSACTION_CANCELATION_REQUESTED', caso: 'fallo_rechazo', handler: transactionCancelHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { voidTransaction: () => Promise.reject(rechazo(422)) } },
  { evento: 'TRANSACTION_CANCELATION_REQUESTED', caso: 'fallo_sin_psp', handler: transactionCancelHandler, body: { transaction: { ...TRANSACCION, pspReference: '' }, action: ACCION }, cliente: {} },
  { evento: 'TRANSACTION_CANCELATION_REQUESTED', caso: 'asincrono_desconocido', handler: transactionCancelHandler, body: { transaction: TRANSACCION, action: ACCION }, cliente: { voidTransaction: () => Promise.reject(rechazo(503)) } },
]

async function respuestaDe({ handler, body, cliente }: Caso): Promise<unknown> {
  vi.mocked(wompiClient).mockReturnValue(cliente as unknown as ReturnType<typeof wompiClient>)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const req = { rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest
  let enviado: unknown
  let status = 200
  const reply = {
    status: (s: number) => ((status = s), reply),
    send: (p: unknown) => ((enviado = p), reply),
  }
  const promesa = handler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync() // el sondeo del reembolso espera con setTimeout
  await promesa
  expect(status).toBe(200) // una respuesta contractual nunca es un 401
  return enviado
}

const archivo = (c: Pick<Caso, 'evento' | 'caso'>) => `${c.evento}__${c.caso}.json`

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('contrato de respuestas síncronas con Saleor (B-1303)', () => {
  it.each(CASOS.map((c) => [archivo(c), c] as const))('%s', async (_nombre, c) => {
    const fixture = { evento: c.evento, caso: c.caso, respuesta: await respuestaDe(c) }
    await expect(JSON.stringify(fixture, null, 2) + '\n').toMatchFileSnapshot(DIR_FIXTURES + archivo(c))
  })

  it('no quedan fixtures huérfanas ni casos duplicados', () => {
    const esperados = CASOS.map(archivo)
    expect(new Set(esperados).size).toBe(esperados.length)
    expect(readdirSync(DIR_FIXTURES).sort()).toEqual([...esperados].sort())
  })
})
