import Fastify from 'fastify'
import { shippingListMethodsHandler } from './webhooks/shipping-list-methods.js'

const app = Fastify({ logger: true })

app.get('/api/manifest', async () => ({
  id: 'app.licona.envios',
  version: '1.0.0',
  name: 'Licona Envíos CO',
  about: 'Integración con Servientrega, Coordinadora y TCC',
  permissions: ['MANAGE_SHIPPING'],
  appUrl: process.env.APP_URL ?? 'http://localhost:3001',
  webhooks: [
    {
      name: 'Shipping methods for checkout',
      syncEvents: ['SHIPPING_LIST_METHODS_FOR_CHECKOUT'],
      isActive: true,
      targetUrl: `${process.env.APP_URL ?? 'http://localhost:3001'}/api/webhooks/shipping-list-methods`,
    },
  ],
  extensions: [],
  requiredSaleorVersion: '>=3.22.0',
}))

app.post('/api/webhooks/shipping-list-methods', shippingListMethodsHandler)

const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1) }
})
