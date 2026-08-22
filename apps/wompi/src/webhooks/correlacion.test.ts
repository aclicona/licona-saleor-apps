import Fastify from 'fastify'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Correlación vista desde fuera: se levanta un Fastify REAL con las opciones de
 * logging REALES, se le inyectan webhooks y se leen los bytes que salen por el
 * stream del logger.
 *
 * Se hace así, y no espiando un doble de `req.log`, porque lo que se quiere fijar
 * es el formato de la línea que acabará en el agregador: si `child()` dejara de
 * propagar los bindings, o si un handler volviera a escribir por `req.log` en vez
 * de por el hijo, un doble no se enteraría y esto sí.
 */

vi.mock('@licona/webhook-utils', async (importarOriginal) => ({
  ...(await importarOriginal<typeof import('@licona/webhook-utils')>()),
  // La firma se prueba a fondo en packages/webhook-utils; aquí estorba.
  verifySaleorWebhook: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/wompi-client.js', () => ({
  wompiClient: vi.fn(),
}))

import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { opcionesLogger, opcionesServidor } from '../lib/logging.js'
import { paymentGatewayInitializeHandler } from './payment-gateway-initialize.js'
import { transactionInitializeHandler } from './transaction-initialize.js'
import { transactionProcessHandler } from './transaction-process.js'
import { transactionChargeHandler } from './transaction-charge.js'
import { transactionRefundHandler } from './transaction-refund.js'
import { transactionCancelHandler } from './transaction-cancel.js'
import { wompiIncomingHandler } from './wompi-incoming.js'

const CHECKOUT_ID = 'Q2hlY2tvdXQ6MQ=='
const TRANSACTION_ID = 'VHJhbnNhY3Rpb246MQ=='
const PSP_REFERENCE = 'wompi-txn-12345'

const entornoOriginal = { ...process.env }

beforeEach(() => {
  process.env.SALEOR_API_URL = 'https://tienda.example.com/graphql/'
  vi.mocked(verifySaleorWebhook).mockResolvedValue(undefined as never)
  vi.mocked(wompiClient).mockReturnValue({
    getPublicKey: () => 'pub_test_key',
    getAcceptanceToken: vi.fn().mockResolvedValue('acc-token'),
    createTransaction: vi.fn().mockResolvedValue({ id: PSP_REFERENCE, redirect_url: 'https://wompi/redirect' }),
    getTransaction: vi.fn().mockResolvedValue({ id: PSP_REFERENCE, status: 'APPROVED' }),
    refundTransaction: vi.fn().mockResolvedValue(undefined),
    voidTransaction: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof wompiClient>)
})

afterEach(() => {
  process.env = { ...entornoOriginal }
  vi.clearAllMocks()
})

/** Servidor con el logger real y su salida capturada línea a línea. */
function servidor() {
  const crudo: string[] = []
  // Las opciones REALES de producción (incluido `genReqId`), con el único
  // cambio de escribir a memoria en vez de a stdout.
  const app = Fastify({
    ...opcionesServidor({}),
    logger: { ...opcionesLogger({}), stream: { write: (linea: string) => void crudo.push(linea) } },
  })
  app.post('/payment-gateway-initialize', paymentGatewayInitializeHandler)
  app.post('/transaction-initialize', transactionInitializeHandler)
  app.post('/transaction-process', transactionProcessHandler)
  app.post('/transaction-charge', transactionChargeHandler)
  app.post('/transaction-refund', transactionRefundHandler)
  app.post('/transaction-cancelation', transactionCancelHandler)
  app.post('/wompi-incoming', wompiIncomingHandler)

  /** Solo las líneas del handler: Fastify también emite `incoming request` y `request completed`. */
  const lineasDelHandler = () =>
    crudo
      .map((linea) => JSON.parse(linea) as Record<string, unknown>)
      .filter((linea) => typeof linea.webhook === 'string')

  return { app, crudo, lineasDelHandler }
}

const payloadTransaccion = {
  transaction: { id: TRANSACTION_ID, pspReference: PSP_REFERENCE },
  action: { amount: 120000, currency: 'COP' },
}

describe('cada webhook emite las claves canónicas en TODA su salida de log', () => {
  it.each([
    [
      'payment-gateway-initialize',
      { sourceObject: { id: CHECKOUT_ID }, data: {}, amount: 120000 },
      { checkoutId: CHECKOUT_ID },
    ],
    [
      'transaction-initialize',
      {
        transaction: { id: TRANSACTION_ID, pspReference: '' },
        sourceObject: { id: CHECKOUT_ID, email: 'cliente@example.com' },
        action: { amount: 120000, currency: 'COP' },
        data: { method: 'PSE' },
      },
      { checkoutId: CHECKOUT_ID, transactionId: TRANSACTION_ID },
    ],
    ['transaction-process', payloadTransaccion, { transactionId: TRANSACTION_ID, pspReference: PSP_REFERENCE }],
    ['transaction-charge', payloadTransaccion, { transactionId: TRANSACTION_ID, pspReference: PSP_REFERENCE }],
    ['transaction-refund', payloadTransaccion, { transactionId: TRANSACTION_ID, pspReference: PSP_REFERENCE }],
    ['transaction-cancelation', payloadTransaccion, { transactionId: TRANSACTION_ID, pspReference: PSP_REFERENCE }],
  ])('%s', async (ruta, payload, esperado) => {
    const { app, lineasDelHandler } = servidor()

    await app.inject({ method: 'POST', url: `/${ruta}`, payload })

    const lineas = lineasDelHandler()
    // Cada handler deja al menos la línea de entrada: sin evidencia del camino
    // feliz no se puede reconstruir una cadena, solo explicar un fallo.
    expect(lineas.length).toBeGreaterThan(0)
    for (const linea of lineas) {
      for (const [clave, valor] of Object.entries(esperado)) {
        expect(linea[clave]).toBe(valor)
      }
    }
    await app.close()
  })
})

describe('formato de la línea', () => {
  it('lleva las tres claves canónicas, el webhook, el reqId y el mensaje', async () => {
    const { app, lineasDelHandler } = servidor()

    await app.inject({
      method: 'POST',
      url: '/transaction-process',
      payload: payloadTransaccion,
    })

    const [entrada] = lineasDelHandler()
    expect(entrada).toMatchObject({
      level: 30,
      webhook: 'transaction-process-session',
      transactionId: TRANSACTION_ID,
      pspReference: PSP_REFERENCE,
      msg: 'Webhook de Saleor recibido',
    })
    // El reqId es el identificador del salto local, complementario a las claves
    // de dominio: junta las líneas de UNA petición de esta App.
    expect(typeof entrada.reqId).toBe('string')
    await app.close()
  })

  it('todas las líneas de una misma petición comparten reqId', async () => {
    const { app, lineasDelHandler } = servidor()

    await app.inject({ method: 'POST', url: '/transaction-process', payload: payloadTransaccion })

    const ids = new Set(lineasDelHandler().map((linea) => linea.reqId))
    expect(ids.size).toBe(1)
    await app.close()
  })

  it('peticiones distintas no comparten reqId', async () => {
    const { app, lineasDelHandler } = servidor()

    await app.inject({ method: 'POST', url: '/transaction-process', payload: payloadTransaccion })
    await app.inject({ method: 'POST', url: '/transaction-process', payload: payloadTransaccion })

    const ids = new Set(lineasDelHandler().map((linea) => linea.reqId))
    expect(ids.size).toBe(2)
    await app.close()
  })
})

describe('lo rechazado también se puede correlacionar', () => {
  it('un 401 por firma inválida deja las claves canónicas y el motivo', async () => {
    // Distinguir "clave rotada, se resuelve sola" de "alguien está probando
    // suerte" era imposible: los dos casos escribían la misma línea.
    vi.mocked(verifySaleorWebhook).mockRejectedValue(
      new SaleorWebhookError('firma inválida', undefined, 'unknown_key'),
    )
    const { app, lineasDelHandler } = servidor()

    const respuesta = await app.inject({ method: 'POST', url: '/transaction-process', payload: payloadTransaccion })

    expect(respuesta.statusCode).toBe(401)
    const rechazo = lineasDelHandler().find((linea) => linea.level === 40)
    expect(rechazo).toMatchObject({
      motivo: 'unknown_key',
      transactionId: TRANSACTION_ID,
      pspReference: PSP_REFERENCE,
    })
    await app.close()
  })

  it('un payload basura no revienta el handler: correlaciona con lo que haya', async () => {
    const { app, lineasDelHandler } = servidor()

    const respuesta = await app.inject({ method: 'POST', url: '/payment-gateway-initialize', payload: {} })

    expect(respuesta.statusCode).toBe(200)
    const [entrada] = lineasDelHandler()
    expect(entrada.webhook).toBe('payment-gateway-initialize-session')
    expect(entrada).not.toHaveProperty('checkoutId')
    await app.close()
  })
})

describe('webhook entrante de Wompi', () => {
  it('correlaciona por pspReference incluso cuando rechaza la firma', async () => {
    process.env.WOMPI_EVENTS_SECRET = 'secreto-de-prueba'
    const { app, lineasDelHandler } = servidor()

    const respuesta = await app.inject({
      method: 'POST',
      url: '/wompi-incoming',
      payload: {
        event: 'transaction.updated',
        data: { transaction: { id: PSP_REFERENCE, status: 'APPROVED', reference: TRANSACTION_ID, amount_in_cents: 12_000_000 } },
        signature: { properties: ['transaction.id'], timestamp: 1_700_000_000, checksum: 'CHECKSUM-QUE-NO-CUADRA' },
      },
    })

    // El código HTTP es lógica de dinero y no se toca: firma inválida → 401.
    expect(respuesta.statusCode).toBe(401)
    for (const linea of lineasDelHandler()) {
      expect(linea.pspReference).toBe(PSP_REFERENCE)
      expect(linea.webhook).toBe('wompi-incoming')
    }
    await app.close()
  })
})
