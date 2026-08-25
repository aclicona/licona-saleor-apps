import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// La verificación de firma se neutraliza porque no es lo que se prueba aquí:
// tiene su propia cobertura en `packages/webhook-utils`. Se conserva el resto
// del módulo con `importOriginal` para no perder `SaleorWebhookError`, que el
// handler usa con `instanceof` — un mock que lo sustituyera por otra clase
// haría que la rama del `catch` se comportara distinto que en producción.
vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))

// El cliente de Wompi se mockea entero: lo que se observa es QUÉ se le manda a
// la pasarela, no cómo se serializa el HTTP.
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import type { CreateTransactionParams, WompiTransaction } from '../lib/wompi-client.js'
import { transactionIdDesdeReferencia } from '../lib/referencia.js'
import { transactionInitializeHandler } from './transaction-initialize.js'

/**
 * Este archivo cubre UN invariante, no el handler entero:
 *
 *   la `reference` que sale hacia Wompi es el ID de transacción de Saleor, y
 *   nada de lo que el comprador ponga en `paymentData` puede cambiarla.
 *
 * Por qué merece un test propio: `data` es el `paymentData` que el storefront
 * envía y que el comprador controla desde su navegador. La referencia vuelve
 * intacta en el evento entrante de Wompi y `wompi-incoming` la usa como `id`
 * de `transactionEventReport`. Una referencia arbitraria ahí no produce un
 * error visible: produce un `NOT_FOUND` que se clasifica como fallo permanente,
 * un 200 a Wompi, el fin de los reintentos, y un pago cobrado que Saleor nunca
 * marca como pagado. El fallo es silencioso y sale caro, así que se ata aquí.
 */

/** ID global de transacción con el formato real del fork: `base64("TransactionItem:<uuid>")`. */
function idGlobalDeTransaccion(): string {
  return Buffer.from(`TransactionItem:${randomUUID()}`, 'utf8').toString('base64')
}

const createTransaction = vi.fn<[CreateTransactionParams], Promise<WompiTransaction>>()
const getAcceptanceToken = vi.fn<[], Promise<string>>()

/** Doble de FastifyRequest con el logger hijo que construye el handler. */
function crearRequest(cuerpo: unknown) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  }
  log.child.mockImplementation(() => log)

  const req = {
    rawBody: JSON.stringify(cuerpo),
    body: cuerpo,
    headers: { 'saleor-signature': 'firma-valida-porque-la-verificación-está-mockeada' },
    log,
  }

  return { req: req as unknown as FastifyRequest, log }
}

/** Doble de FastifyReply que registra el status y el cuerpo enviados. */
function crearReply() {
  const captura: { status: number; payload: unknown } = { status: 200, payload: undefined }

  const reply = {
    status(codigo: number) {
      captura.status = codigo
      return reply
    },
    send(payload: unknown) {
      captura.payload = payload
      return reply
    },
  }

  return { reply: reply as unknown as FastifyReply, captura }
}

/** Payload de TRANSACTION_INITIALIZE_SESSION tal y como lo arma la subscription del manifiesto. */
function payloadSaleor(transactionId: string, data?: Record<string, unknown>) {
  return {
    transaction: { id: transactionId, pspReference: '' },
    action: { amount: 120_000, currency: 'COP' },
    sourceObject: { id: 'Q2hlY2tvdXQ6MQ==', email: 'cliente@example.com' },
    ...(data ? { data } : {}),
  }
}

/** La `reference` que de verdad recibió el cliente de Wompi. */
function referenciaEnviadaAWompi(): unknown {
  expect(createTransaction).toHaveBeenCalledTimes(1)
  return createTransaction.mock.calls[0][0].reference
}

beforeEach(() => {
  vi.clearAllMocks()
  getAcceptanceToken.mockResolvedValue('acceptance-token-de-prueba')
  createTransaction.mockResolvedValue({
    id: 'wompi-txn-12345',
    status: 'PENDING',
    reference: 'irrelevante-para-estos-tests',
    amount_in_cents: 12_000_000,
    currency: 'COP',
    payment_method_type: 'PSE',
    redirect_url: 'https://checkout.wompi.co/l/abc123',
  })
  vi.mocked(wompiClient).mockReturnValue({
    getAcceptanceToken,
    createTransaction,
  } as unknown as ReturnType<typeof wompiClient>)
})

describe('transactionInitializeHandler — la referencia que viaja a Wompi', () => {
  it('manda a Wompi el id de transacción de Saleor como referencia', async () => {
    const transactionId = idGlobalDeTransaccion()
    const { req } = crearRequest(payloadSaleor(transactionId))
    const { reply, captura } = crearReply()

    await transactionInitializeHandler(req, reply)

    expect(referenciaEnviadaAWompi()).toBe(transactionId)
    expect(captura.status).toBe(200)
  })

  it('ignora cualquier referencia que venga dentro de paymentData y sigue mandando el id de Saleor', async () => {
    // El caso que motiva todo el módulo `referencia`. `paymentData` lo compone
    // el storefront y viaja por el navegador del comprador: si el handler
    // aceptara una referencia de ahí, cualquiera podría hacer que la
    // confirmación de su propio pago llegase a Saleor con un id que no
    // resuelve, y el cobro quedaría hecho sin quedar registrado.
    const transactionId = idGlobalDeTransaccion()
    const { req } = crearRequest(
      payloadSaleor(transactionId, {
        method: 'PSE',
        idempotencyKey: 'clave-del-storefront',
        user_legal_id: '1020304050',
        financial_institution_code: '1007',
      }),
    )
    const { reply } = crearReply()

    await transactionInitializeHandler(req, reply)

    expect(referenciaEnviadaAWompi()).toBe(transactionId)
  })

  it.each([
    ['reference', { reference: 'referencia-del-comprador' }],
    ['idempotencyKey', { idempotencyKey: 'clave-del-storefront' }],
    ['transactionId falsificado', { transactionId: 'VHJhbnNhY3Rpb25JdGVtOjE=' }],
  ])('no deja que el campo %s de paymentData contamine la referencia', async (_titulo, inyectado) => {
    // Se prueban varios nombres a propósito: el arreglo no consiste en dejar
    // de leer UN campo concreto, sino en que la referencia deje de depender
    // de `data` sea cual sea la clave que alguien añada mañana.
    const transactionId = idGlobalDeTransaccion()
    const { req } = crearRequest(payloadSaleor(transactionId, { method: 'NEQUI', ...inyectado }))
    const { reply } = crearReply()

    await transactionInitializeHandler(req, reply)

    expect(referenciaEnviadaAWompi()).toBe(transactionId)
  })

  it('manda una referencia que el webhook entrante podrá resolver de vuelta a la transacción', async () => {
    // Este es el test que ata los dos extremos del camino del dinero: lo que
    // sale por `transaction-initialize` tiene que sobrevivir el viaje de ida y
    // vuelta por Wompi y volver a ser el id que `wompi-incoming` le pasa a
    // `transactionEventReport`. Comprobar solo la igualdad con `transaction.id`
    // no lo garantiza el día que `referenciaParaWompi` codifique algo.
    const transactionId = idGlobalDeTransaccion()
    const { req } = crearRequest(payloadSaleor(transactionId, { method: 'PSE', idempotencyKey: 'clave-del-storefront' }))
    const { reply } = crearReply()

    await transactionInitializeHandler(req, reply)

    expect(transactionIdDesdeReferencia(referenciaEnviadaAWompi())).toBe(transactionId)
  })
})
