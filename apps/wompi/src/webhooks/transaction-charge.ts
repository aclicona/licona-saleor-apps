import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'

interface TransactionChargePayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

export async function transactionChargeHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    await verifySaleorWebhook(JSON.stringify(req.body), req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const { transaction, action } = req.body as TransactionChargePayload
  // Wompi auto-captures on approval — nothing to do, just confirm.
  return reply.send({
    result: 'CHARGE_SUCCESS',
    amount: action.amount,
    pspReference: transaction.pspReference ?? '',
  })
}
