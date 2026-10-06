import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'

interface TransactionRefundPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

/** Sondeo del estado del reembolso: 6 x 1,5 s = 9 s, bajo los 18 s de Saleor. */
const MAX_SONDEOS = 6
const INTERVALO_SONDEO_MS = 1500

export async function transactionRefundHandler(req: FastifyRequest, reply: FastifyReply) {
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-refund-requested', ...camposDeCorrelacion(req.body) })
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

  const { transaction, action } = req.body as TransactionRefundPayload
  if (!transaction.pspReference) {
    log.warn('Sin pspReference en el payload: no hay transacción de Wompi que reembolsar')
    return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: 'Sin pspReference' })
  }

  try {
    const cliente = wompiClient()
    let refund = await cliente.refundTransaction(transaction.pspReference, copToCents(action.amount))
    log.info({ refundId: refund.id, estadoRefund: refund.status }, 'Reembolso creado en Wompi')

    // Wompi crea el reembolso en PENDING y lo aprueba unos segundos después.
    // Se sondea dentro del presupuesto del webhook síncrono de Saleor (18 s de
    // espera de respuesta: WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT).
    for (let i = 0; i < MAX_SONDEOS && refund.status === 'PENDING'; i++) {
      await new Promise((r) => setTimeout(r, INTERVALO_SONDEO_MS))
      refund = await cliente.getRefund(refund.id)
    }

    const pspReference = String(refund.id)
    if (refund.status === 'APPROVED') {
      return reply.send({ result: 'REFUND_SUCCESS', amount: action.amount, pspReference })
    }
    if (refund.status === 'PENDING') {
      // SEGUIMIENTO PENDIENTE: el esquema síncrono de Saleor solo admite
      // REFUND_SUCCESS/REFUND_FAILURE; responder solo con `pspReference` (sin
      // `result`) lo trata como asíncrono: queda en REFUND_REQUEST a la espera
      // de un `transactionEventReport` que hoy nadie envía. Falta una tarea
      // que consulte GET /refunds/{id} y reporte el desenlace.
      log.warn({ refundId: refund.id }, 'Reembolso pendiente en Wompi, revisar')
      return reply.send({ pspReference })
    }
    log.warn({ refundId: refund.id, estadoRefund: refund.status }, 'Wompi no aprobó el reembolso')
    return reply.send({
      result: 'REFUND_FAILURE',
      amount: action.amount,
      pspReference,
      message: refund.status_message ?? `Reembolso ${refund.status} en Wompi`,
    })
  } catch (error) {
    log.error(error)
    return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: String(error) })
  }
}
