import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'

interface TransactionInitializePayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number; currency: string }
  data?: { method?: string; idempotencyKey?: string }
  sourceObject?: { userEmail?: string; billingAddress?: { email?: string } }
}

export async function transactionInitializeHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    await verifySaleorWebhook(JSON.stringify(req.body), req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const payload = req.body as TransactionInitializePayload
  const { transaction, action, data, sourceObject } = payload

  const reference = data?.idempotencyKey ?? transaction.id
  const method = data?.method ?? 'CARD'
  const customerEmail = sourceObject?.userEmail ?? sourceObject?.billingAddress?.email ?? ''
  const storefrontUrl = process.env.STOREFRONT_URL ?? 'http://localhost:3000'

  try {
    // Saleor sends COP amount. Wompi expects centavos (× 100).
    const amountInCents = Math.round(action.amount * 100)
    const client = wompiClient()

    const wompiTxn = await client.createTransaction({
      amountInCents,
      currency: 'COP',
      customerEmail,
      reference,
      redirectUrl: `${storefrontUrl}/checkout/orden?txn=${transaction.id}`,
      paymentMethod: { type: method },
    })

    return reply.send({
      result: 'CHARGE_ACTION_REQUIRED',
      amount: action.amount,
      pspReference: wompiTxn.id,
      data: { redirectUrl: wompiTxn.redirect_url, wompiTransactionId: wompiTxn.id },
    })
  } catch (error) {
    req.log.error(error)
    return reply.send({
      result: 'CHARGE_FAILURE',
      amount: action.amount,
      message: error instanceof Error ? error.message : 'Error al crear transacción en Wompi',
    })
  }
}
