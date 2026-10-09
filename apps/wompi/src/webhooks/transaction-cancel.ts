import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError, crearPlazo } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'
import { esRechazoDefinitivo } from '../lib/wompi-error.js'

interface TransactionCancelPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

/** Mensaje fijo hacia Saleor: el texto del error real va solo al log. */
const MENSAJE_RECHAZO = 'Wompi rechazó la solicitud de anulación'

export async function transactionCancelHandler(req: FastifyRequest, reply: FastifyReply) {
  // El plazo global cuenta desde la llegada de la petición (B-1080): ver transaction-process.ts.
  const plazo = crearPlazo()
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-cancelation-requested', ...camposDeCorrelacion(req.body) })
  log.info('Webhook de Saleor recibido')

  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    // `reason` distingue "clave rotada, se resuelve sola" de "alguien está
    // probando suerte": son incidentes distintos y sin esto se ven igual.
    if (e instanceof SaleorWebhookError) log.warn({ motivo: e.reason }, e.message)
    else log.warn({ error: String(e) }, 'Fallo inesperado verificando la firma de Saleor')
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const { transaction, action } = req.body as TransactionCancelPayload
  if (!transaction.pspReference) {
    log.warn('Sin pspReference en el payload: no hay transacción de Wompi que anular')
    return reply.send({ result: 'CANCEL_FAILURE', amount: action.amount, message: 'Sin pspReference' })
  }

  try {
    await wompiClient().voidTransaction(transaction.pspReference, plazo.signal)
    log.info('Anulación aceptada por Wompi')
    return reply.send({ result: 'CANCEL_SUCCESS', amount: action.amount, pspReference: transaction.pspReference })
  } catch (error) {
    // Rechazo cierto: un 4xx de validación (excepto 408/429) = la anulación no se aplicó.
    if (esRechazoDefinitivo(error)) {
      log.error({ err: error, status: error.status, amount: action.amount }, 'Wompi rechazó la anulación')
      return reply.send({ result: 'CANCEL_FAILURE', amount: action.amount, message: MENSAJE_RECHAZO })
    }
    // B-1072: CANCEL_FAILURE es final en Saleor. Un timeout, un fallo de red, un 5xx
    // o un 408/429 dejan el estado DESCONOCIDO (la anulación pudo aplicarse en Wompi).
    // Sin `result` + `pspReference` Saleor lo trata como respuesta asíncrona y deja el
    // evento CANCEL_REQUEST, no final. El texto del error va solo al log.
    log.error(
      { err: error, amount: action.amount },
      'Estado de la anulación en Wompi desconocido; se responde sin resultado final (CANCEL_REQUEST) para no cerrarla como fallida',
    )
    return reply.send({ pspReference: transaction.pspReference })
  } finally {
    plazo.limpiar()
  }
}
