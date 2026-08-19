import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'

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
  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const { transaction, action } = req.body as TransactionProcessPayload
  if (!transaction.pspReference) {
    return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: 'Sin transacción activa' })
  }

  try {
    const wompiTxn = await wompiClient().getTransaction(transaction.pspReference)
    return reply.send({
      result: WOMPI_STATUS_MAP[wompiTxn.status] ?? 'CHARGE_ACTION_REQUIRED',
      amount: action.amount,
      pspReference: transaction.pspReference,
    })
  } catch (error) {
    req.log.error(error)
    return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: String(error) })
  }
}
