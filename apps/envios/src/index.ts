import Fastify from 'fastify'
import { shippingListMethodsHandler } from './webhooks/shipping-list-methods.js'

const app = Fastify({ logger: true })

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001'

app.get('/', async (request, reply) => {
  reply.type('text/html')
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Licona Envíos CO</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F4EFE6;color:#1A1613}
  .box{text-align:center;padding:2rem;border:1px solid #ccc;border-radius:8px;background:#fff}
  h1{margin:0 0 .5rem}p{margin:0;color:#666;font-size:.9rem}</style></head>
  <body><div class="box"><h1>Licona Envíos CO</h1><p>App de envíos activa — Servientrega · Coordinadora · TCC</p></div></body></html>`
})

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
      query: `subscription {
  event {
    ... on ShippingListMethodsForCheckout {
      checkout {
        id
        shippingAddress {
          city
          postalCode
          countryArea
        }
        lines {
          quantity
          variant {
            weight { value unit }
            product { weight { value unit } }
          }
        }
      }
    }
  }
}`,
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
