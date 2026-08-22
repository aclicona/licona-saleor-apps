import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'

interface TransactionInitializePayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number; currency: string }
  data?: {
    method?: string
    idempotencyKey?: string
    // NEQUI
    phone_number?: string
    // PSE + BANCOLOMBIA_TRANSFER
    user_type?: string
    payment_description?: string
    // PSE only
    user_legal_id_type?: string
    user_legal_id?: string
    financial_institution_code?: string
  }
  sourceObject?: { email?: string; billingAddress?: { email?: string } }
}

export async function transactionInitializeHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const payload = req.body as TransactionInitializePayload
  const { transaction, action, data, sourceObject } = payload

  const reference = data?.idempotencyKey ?? transaction.id
  const method = data?.method ?? 'BANCOLOMBIA_TRANSFER'
  const phoneNumber = data?.phone_number
  const customerEmail = sourceObject?.email ?? sourceObject?.billingAddress?.email ?? ''
  const storefrontUrl = process.env.STOREFRONT_URL ?? 'http://localhost:3000'

  if (action.currency !== 'COP') {
    req.log.error({ currency: action.currency }, 'Wompi only supports COP — configure default-channel currency to COP in Saleor')
    return reply.send({
      result: 'CHARGE_FAILURE',
      amount: action.amount,
      message: `Wompi no soporta ${action.currency}. El canal debe usar moneda COP.`,
    })
  }

  try {
    // Saleor sends COP (e.g. 120000). Wompi expects centavos (12000000).
    const amountInCents = copToCents(action.amount)
    const client = wompiClient()
    const acceptanceToken = await client.getAcceptanceToken()

    let paymentMethod: NonNullable<Parameters<typeof client.createTransaction>[0]['paymentMethod']>
    switch (method) {
      case 'PSE':
        paymentMethod = {
          type: 'PSE',
          user_type: data?.user_type ?? 'PERSON',
          user_legal_id_type: data?.user_legal_id_type ?? 'CC',
          user_legal_id: data?.user_legal_id ?? '',
          financial_institution_code: data?.financial_institution_code ?? '',
          payment_description: data?.payment_description ?? 'Pago en Licona',
        }
        break
      case 'BANCOLOMBIA_TRANSFER':
        paymentMethod = {
          type: 'BANCOLOMBIA_TRANSFER',
          user_type: data?.user_type ?? 'PERSON',
          payment_description: data?.payment_description ?? 'Pago en Licona',
        }
        break
      case 'NEQUI':
        paymentMethod = phoneNumber
          ? { type: 'NEQUI', phone_number: phoneNumber }
          : { type: 'NEQUI' }
        break
      default:
        paymentMethod = { type: method }
    }

    const wompiTxn = await client.createTransaction({
      amountInCents,
      currency: 'COP',
      customerEmail,
      reference,
      redirectUrl: `${storefrontUrl}/checkout/orden/${transaction.id}`,
      acceptanceToken,
      paymentMethod,
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
