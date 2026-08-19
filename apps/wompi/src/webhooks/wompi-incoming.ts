import type { FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { reportTransactionEvent } from '../lib/saleor-client.js'

// Wompi signs its own webhooks with HMAC-SHA256 — different from Saleor's JWS.
function verifyWompiSignature(payload: string, timestamp: string, signature: string, secret: string): boolean {
  const toSign = payload + timestamp + secret
  const expected = createHmac('sha256', secret).update(toSign).digest('hex')
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
}

const WOMPI_TO_SALEOR: Record<string, 'CHARGE_SUCCESS' | 'CHARGE_FAILURE'> = {
  APPROVED: 'CHARGE_SUCCESS',
  DECLINED: 'CHARGE_FAILURE',
  ERROR: 'CHARGE_FAILURE',
  VOIDED: 'CHARGE_FAILURE',
}

interface WompiEvent {
  data: { transaction: { id: string; status: string; reference: string; amount_in_cents: number } }
}

export async function wompiIncomingHandler(req: FastifyRequest, reply: FastifyReply) {
  const rawBody = (req as any).rawBody as string
  const timestamp = req.headers['x-event-created-at'] as string ?? ''
  const signature = req.headers['x-signature'] as string ?? ''
  const secret = process.env.WOMPI_EVENTS_SECRET ?? ''

  if (secret && !verifyWompiSignature(rawBody, timestamp, signature, secret)) {
    req.log.warn('Invalid Wompi signature')
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const event = req.body as WompiEvent
  const txn = event?.data?.transaction
  if (!txn) return reply.send({ ok: true })

  const saleorEventType = WOMPI_TO_SALEOR[txn.status]
  if (!saleorEventType) return reply.send({ ok: true })

  try {
    await reportTransactionEvent({
      transactionId: txn.reference,
      type: saleorEventType,
      amount: txn.amount_in_cents / 100,
      pspReference: txn.id,
      message: `Wompi: ${txn.status}`,
    })
  } catch (error) {
    req.log.error({ msg: 'transactionEventReport failed', error })
  }

  return reply.send({ ok: true })
}
