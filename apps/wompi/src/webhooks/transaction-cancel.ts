import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'

interface TransactionCancelPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

export async function transactionCancelHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const { transaction, action } = req.body as TransactionCancelPayload
  if (!transaction.pspReference) {
    return reply.send({ result: 'CANCEL_FAILURE', amount: action.amount, message: 'Sin pspReference' })
  }

  try {
    await wompiClient().voidTransaction(transaction.pspReference)
    return reply.send({ result: 'CANCEL_SUCCESS', amount: action.amount, pspReference: transaction.pspReference })
  } catch (error) {
    req.log.error(error)
    return reply.send({ result: 'CANCEL_FAILURE', amount: action.amount, message: String(error) })
  }
}
