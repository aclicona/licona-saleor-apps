import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { camposDeCorrelacion } from '../lib/correlacion.js'

interface TransactionChargePayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

export async function transactionChargeHandler(req: FastifyRequest, reply: FastifyReply) {
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-charge-requested', ...camposDeCorrelacion(req.body) })
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

  const { transaction, action } = req.body as TransactionChargePayload
  // Wompi auto-captures on approval — nothing to do, just confirm.
  log.info('Captura confirmada sin llamar a Wompi: Wompi captura automáticamente al aprobar')
  return reply.send({
    result: 'CHARGE_SUCCESS',
    amount: action.amount,
    pspReference: transaction.pspReference ?? '',
  })
}
