import Fastify, { type FastifyRequest } from 'fastify'
import { construirManifiesto } from './manifest.js'
import { avisarDerivaAlArranque } from '@licona/webhook-utils'
import { shippingListMethodsHandler } from './webhooks/shipping-list-methods.js'
import { manejadorListo, manejadorRegistro } from './lib/registro.js'
import { avisoNivelLogInvalido, opcionesServidor } from './lib/logging.js'

// El logger ya no se activa a pelo con `true`: `opcionesServidor()` le pone
// nivel (LOG_LEVEL), `redact` para que una credencial no acabe en un log
// retenido, y un `genReqId` que identifica el salto local. Ver lib/logging.ts.
const app = Fastify(opcionesServidor())

const avisoNivel = avisoNivelLogInvalido()
if (avisoNivel) app.log.warn(avisoNivel)

const APP_URL = (process.env.APP_URL ?? 'http://localhost:3002').replace(/\/$/, '')

app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    ;(req as FastifyRequest & { rawBody: string }).rawBody = body as string
    done(null, JSON.parse(body as string))
  } catch (err) {
    done(err as Error, undefined)
  }
})

app.get('/', async (request, reply) => {
  reply.type('text/html')
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Licona Envíos CO</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F4EFE6;color:#1A1613}
  .box{text-align:center;padding:2rem;border:1px solid #ccc;border-radius:8px;background:#fff}
  h1{margin:0 0 .5rem}p{margin:0;color:#666;font-size:.9rem}</style></head>
  <body><div class="box"><h1>Licona Envíos CO</h1><p>App de envíos activa — Servientrega · Coordinadora · TCC</p></div></body></html>`
})

app.get('/api/manifest', async () => construirManifiesto(APP_URL))

// Saleor hace POST del token aquí tras instalar la App. El handler vive en
// lib/registro.ts y NO escribe el valor del token en el log.
app.post('/api/register', manejadorRegistro)

// Healthcheck de cadena (config + Saleor + JWKS). 503 si algo falla.
app.get('/api/health/ready', manejadorListo)

app.post('/api/webhooks/shipping-list-methods', shippingListMethodsHandler)

const PORT = parseInt(process.env.PORT ?? '3002', 10)
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1) }

  // B-406: Saleor congela las suscripciones al instalar; si el manifiesto vivo ya
  // no coincide con lo instalado, se grita en el log (no repara, no bloquea).
  void app.inject('/api/manifest').then((res) =>
    avisarDerivaAlArranque({
      webhooksManifiesto: res.json().webhooks,
      saleorApiUrl: process.env.SALEOR_API_URL ?? '',
      appToken: process.env.SALEOR_APP_TOKEN ?? '',
      log: app.log,
    }),
  )
})
