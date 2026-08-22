import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'

interface TransactionProcessPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

const WOMPI_STATUS_MAP: Record<string, string> = {
  APPROVED: 'CHARGE_SUCCESS',
  DECLINED: 'CHARGE_FAILURE',
  ERROR: 'CHARGE_FAILURE',
  VOIDED: 'CHARGE_FAILURE',
  PENDING: 'CHARGE_ACTION_REQUIRED',
}

export async function transactionProcessHandler(req: FastifyRequest, reply: FastifyReply) {
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-process-session', ...camposDeCorrelacion(req.body) })
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

  const { transaction, action } = req.body as TransactionProcessPayload
  if (!transaction.pspReference) {
    log.warn('Sin pspReference en el payload: no hay transacción de Wompi que consultar')
    return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: 'Sin transacción activa' })
  }

  try {
    const wompiTxn = await wompiClient().getTransaction(transaction.pspReference)
    log.info({ estadoWompi: wompiTxn.status }, 'Estado consultado en Wompi')
    return reply.send({
      result: WOMPI_STATUS_MAP[wompiTxn.status] ?? 'CHARGE_ACTION_REQUIRED',
      amount: action.amount,
      pspReference: transaction.pspReference,
    })
  } catch (error) {
    log.error(error)
    return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: String(error) })
  }
}
