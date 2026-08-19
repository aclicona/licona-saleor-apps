import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'

interface ShippingCheckoutPayload {
  checkout: {
    id: string
    shippingAddress: {
      city: string
      postalCode: string
      countryArea: string
    } | null
    lines: Array<{
      quantity: number
      variant: {
        weight: { value: number; unit: string } | null
        product: { weight: { value: number; unit: string } | null }
      }
    }>
  }
}

function calculateTotalWeightKg(lines: ShippingCheckoutPayload['checkout']['lines']): number {
  return lines.reduce((total, line) => {
    const weight = line.variant.weight?.value ?? line.variant.product.weight?.value ?? 0.5
    return total + weight * line.quantity
  }, 0)
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

  const servientregaPrice = 8000 + Math.max(0, weightKg - 1) * 2000
  const coordinadoraPrice = 9000 + Math.max(0, weightKg - 1) * 1800
  const tccPrice          = 10000 + Math.max(0, weightKg - 1) * 1500

  return reply.send([
    {
      id: 'servientrega-estandar',
      name: 'Servientrega Estándar (3-5 días)',
      amount: Math.round(servientregaPrice),
      currency: 'COP',
      maximumDeliveryDays: 5,
      minimumDeliveryDays: 3,
    },
    {
      id: 'coordinadora-estandar',
      name: 'Coordinadora Estándar (3-5 días)',
      amount: Math.round(coordinadoraPrice),
      currency: 'COP',
      maximumDeliveryDays: 5,
      minimumDeliveryDays: 3,
    },
    {
      id: 'tcc-express',
      name: 'TCC Express (1-2 días)',
      amount: Math.round(tccPrice),
      currency: 'COP',
      maximumDeliveryDays: 2,
      minimumDeliveryDays: 1,
    },
  ])
}
