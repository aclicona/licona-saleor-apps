import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'

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
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-initialize-session', ...camposDeCorrelacion(req.body) })
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

  const payload = req.body as TransactionInitializePayload
  const { transaction, action, data, sourceObject } = payload

  const reference = data?.idempotencyKey ?? transaction.id
  const method = data?.method ?? 'BANCOLOMBIA_TRANSFER'
  const phoneNumber = data?.phone_number
  const customerEmail = sourceObject?.email ?? sourceObject?.billingAddress?.email ?? ''
  const storefrontUrl = process.env.STOREFRONT_URL ?? 'http://localhost:3000'

  if (action.currency !== 'COP') {
    log.error({ currency: action.currency }, 'Wompi only supports COP — configure default-channel currency to COP in Saleor')
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

    // Camino feliz explícito: aquí es donde el hilo de Saleor se ata al de
    // Wompi (el id de Wompi pasa a ser el pspReference). Sin esta línea la
    // cadena solo se puede reconstruir cuando algo falla.
    log.info({ pspReference: wompiTxn.id, metodo: method }, 'Transacción creada en Wompi')

    return reply.send({
      result: 'CHARGE_ACTION_REQUIRED',
      amount: action.amount,
      pspReference: wompiTxn.id,
      data: { redirectUrl: wompiTxn.redirect_url, wompiTransactionId: wompiTxn.id },
    })
  } catch (error) {
    log.error(error)
    return reply.send({
      result: 'CHARGE_FAILURE',
      amount: action.amount,
      message: error instanceof Error ? error.message : 'Error al crear transacción en Wompi',
    })
  }
}
