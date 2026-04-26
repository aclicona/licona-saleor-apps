import type { FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'

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

function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
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
  const secret = process.env.SALEOR_WEBHOOK_SECRET ?? ''
  const signature = (request.headers['saleor-signature'] as string) ?? ''
  const rawBody = JSON.stringify(request.body)

  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const payload = request.body as ShippingCheckoutPayload
  const { shippingAddress, lines } = payload.checkout

  if (!shippingAddress) {
    return reply.send([])
  }

  const weightKg = calculateTotalWeightKg(lines)

  const servientregaPrice = 8000 + Math.max(0, weightKg - 1) * 2000
  const coordinadoraPrice = 9000 + Math.max(0, weightKg - 1) * 1800
  const tccPrice = 10000 + Math.max(0, weightKg - 1) * 1500

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
