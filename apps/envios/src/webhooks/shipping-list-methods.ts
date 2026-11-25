import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { camposDeCorrelacion } from '../lib/correlacion.js'
import { conEnvioGratis, envioGratisVigente } from '../lib/envio-gratis.js'
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
  // Logger de la petición con las claves canónicas ya puestas (mismo patrón que
  // los handlers de wompi). Se construye ANTES de verificar la firma para que
  // también quede constancia de lo que se rechaza.
  const log = request.log.child({ webhook: 'shipping-list-methods', ...camposDeCorrelacion(request.body) })
  log.info('Webhook de Saleor recibido')

  const signature = request.headers['saleor-signature'] as string | undefined
  const rawBody = (request as any).rawBody as string
  const saleorApiUrl = process.env.SALEOR_API_URL ?? ''

  try {
    await verifySaleorWebhook(rawBody, signature, saleorApiUrl)
  } catch (err) {
    // `reason` distingue "clave rotada, se resuelve sola" de "alguien está
    // probando suerte": son incidentes distintos y sin esto se ven igual.
    if (err instanceof SaleorWebhookError) log.warn({ motivo: err.reason }, err.message)
    else log.warn({ error: String(err) }, 'Fallo inesperado verificando la firma de Saleor')
    return reply.status(401).send({ error: 'Invalid webhook signature' })
  }

  const payload = request.body as ShippingCheckoutPayload
  const { shippingAddress, lines } = payload.checkout

  if (!shippingAddress) {
    return reply.send([])
  }

  const weightKg = calculateTotalWeightKg(lines)

  const metodos = cotizarEnvios(weightKg)

  // Envío gratis temporal (B-2451): solo se ofrece mientras ENVIO_GRATIS_HASTA esté vigente.
  const gratis = envioGratisVigente(process.env.ENVIO_GRATIS_HASTA, new Date())
  if (gratis.motivo) log.warn({ motivo: gratis.motivo }, 'Envío gratis temporal no ofrecido')
  if (!gratis.vigente) return reply.send(metodos)

  log.info({ hasta: gratis.hasta?.toISOString() }, 'Se ofrece el envío gratis temporal')
  return reply.send(conEnvioGratis(metodos))
}
