import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'

interface TransactionRefundPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

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
    await wompiClient().refundTransaction(transaction.pspReference, copToCents(action.amount))
    log.info({ importeCop: action.amount }, 'Reembolso aceptado por Wompi')
    return reply.send({ result: 'REFUND_SUCCESS', amount: action.amount, pspReference: transaction.pspReference })
  } catch (error) {
    log.error(error)
    return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: String(error) })
  }
}
