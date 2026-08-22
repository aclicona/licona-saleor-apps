import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { calculateTotalWeightKg, cotizarEnvios, type ShippingLine } from '../lib/tarifas.js'

interface ShippingCheckoutPayload {
  checkout: {
    id: string
    shippingAddress: {
      city: string
      postalCode: string
      countryArea: string
    } | null
    lines: ShippingLine[]
  }
}

export async function shippingListMethodsHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const signature = request.headers['saleor-signature'] as string | undefined
  const rawBody = (request as any).rawBody as string
  const saleorApiUrl = process.env.SALEOR_API_URL ?? ''

  try {
    await verifySaleorWebhook(rawBody, signature, saleorApiUrl)
  } catch (err) {
    if (err instanceof SaleorWebhookError) {
      request.log.warn({ msg: err.message, cause: err.cause })
    }
    return reply.status(401).send({ error: 'Invalid webhook signature' })
  }

  const payload = request.body as ShippingCheckoutPayload
  const { shippingAddress, lines } = payload.checkout

  if (!shippingAddress) {
    return reply.send([])
  }

  const weightKg = calculateTotalWeightKg(lines)

  return reply.send(cotizarEnvios(weightKg))
}
