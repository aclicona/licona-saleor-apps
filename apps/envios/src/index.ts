import Fastify from 'fastify'
import { shippingListMethodsHandler } from './webhooks/shipping-list-methods.js'

const app = Fastify({ logger: true })

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001'

app.get('/api/manifest', async () => ({
  id: 'app.licona.envios',
  version: '1.0.0',
  name: 'Licona Envíos CO',
  about: 'Integración con Servientrega, Coordinadora y TCC',
  permissions: ['MANAGE_SHIPPING'],
  appUrl: APP_URL,
  tokenTargetUrl: `${APP_URL}/api/register`,
  webhooks: [
    {
      name: 'Shipping methods for checkout',
      syncEvents: ['SHIPPING_LIST_METHODS_FOR_CHECKOUT'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/shipping-list-methods`,
    },
  ],
  extensions: [],
  requiredSaleorVersion: '>=3.22.0',
}))

// Saleor posts the auth token here after installation
app.post('/api/register', async (request, reply) => {
  const { auth_token } = request.body as { auth_token: string }
  if (!auth_token) return reply.status(400).send({ error: 'Missing auth_token' })
  // Token stored in env for now — replace with APL (Upstash) in Fase 3
  app.log.info({ msg: 'App registered', token: auth_token.slice(0, 8) + '...' })
  return reply.status(200).send({ success: true })
})

app.post('/api/webhooks/shipping-list-methods', shippingListMethodsHandler)

const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1) }
})
