import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'

interface TransactionRefundPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

export async function transactionRefundHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const { transaction, action } = req.body as TransactionRefundPayload
  if (!transaction.pspReference) {
    return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: 'Sin pspReference' })
  }

  try {
    await wompiClient().refundTransaction(transaction.pspReference, copToCents(action.amount))
    return reply.send({ result: 'REFUND_SUCCESS', amount: action.amount, pspReference: transaction.pspReference })
  } catch (error) {
    req.log.error(error)
    return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: String(error) })
  }
}
