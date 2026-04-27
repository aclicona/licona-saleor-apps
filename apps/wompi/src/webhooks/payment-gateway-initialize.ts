import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'

export async function paymentGatewayInitializeHandler(req: FastifyRequest, reply: FastifyReply) {
  try {
    await verifySaleorWebhook(JSON.stringify(req.body), req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    if (e instanceof SaleorWebhookError) req.log.warn(e.message)
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const client = wompiClient()
  return reply.send({
    data: {
      publicKey: client.getPublicKey(),
      methods: ['CARD', 'PSE', 'NEQUI', 'DAVIPLATA', 'BANCOLOMBIA_TRANSFER'],
      currency: 'COP',
    },
  })
}
