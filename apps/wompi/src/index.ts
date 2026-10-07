import Fastify, { type FastifyRequest } from 'fastify'
import { construirManifiesto } from './manifest.js'
import { comprobarDerivaDesdeManifiesto } from '@licona/webhook-utils'
import { paymentGatewayInitializeHandler } from './webhooks/payment-gateway-initialize.js'
import { transactionInitializeHandler } from './webhooks/transaction-initialize.js'
import { transactionProcessHandler } from './webhooks/transaction-process.js'
import { transactionChargeHandler } from './webhooks/transaction-charge.js'
import { transactionRefundHandler } from './webhooks/transaction-refund.js'
import { transactionCancelHandler } from './webhooks/transaction-cancel.js'
import {
  conciliacionHabilitada,
  conciliarTransaccionesWompi,
  crearHandlerConciliacion,
  ventanaDeConciliacion,
  type VentanaConsulta,
} from './lib/conciliacion.js'
import {
  RETRASO_INICIAL_MS,
  intervaloDeConciliacion,
  programarConciliacionPeriodica,
  type ProgramadorConciliacion,
} from './lib/conciliacion-periodica.js'
import { wompiClient } from './lib/wompi-client.js'
import { reportTransactionEvent } from './lib/saleor-client.js'
import { wompiIncomingHandler } from './webhooks/wompi-incoming.js'
import { appRegistrada, mensajeModoDegradado, verificarConfiguracionAlArranque } from './lib/config.js'
import { exigirAppRegistrada, manejadorListo, seguimientoDeriva, manejadorRegistro, manejadorSalud } from './lib/registro.js'
import { avisoNivelLogInvalido, opcionesServidor } from './lib/logging.js'

// Fail-fast ANTES de crear el servidor: sin las variables obligatorias el
// proceso no arranca. En un producto single-tenant replicable, una variable
// ausente es el fallo normal del aprovisionamiento y tiene que ser un deploy
// rojo — nunca una App que levanta aceptando pagos anónimos.
//
// Ojo con el alcance: esto NO cubre `SALEOR_APP_TOKEN`, que es requisito de
// *operación* y no de arranque. El porqué está en lib/config.ts.
verificarConfiguracionAlArranque()

// El logger ya no se activa a pelo con `true`: `opcionesServidor()` le pone
// nivel (LOG_LEVEL), `redact` para que una credencial no acabe en un log
// retenido, y un `genReqId` que identifica el salto local. Ver lib/logging.ts.
const app = Fastify(opcionesServidor())

// Un LOG_LEVEL inválido no tumba el proceso (ver lib/logging.ts), pero tampoco
// se traga en silencio: se avisa en cuanto hay logger con el que avisar.
const avisoNivel = avisoNivelLogInvalido()
if (avisoNivel) app.log.warn(avisoNivel)

// Aviso de modo degradado. Va inmediatamente después de crear el logger y antes
// de registrar una sola ruta, para que sea lo primero que se lea en el log de
// arranque y nadie confunda "levantó" con "está operativa".
const avisoDegradado = mensajeModoDegradado()
if (avisoDegradado) app.log.warn(avisoDegradado)
const APP_URL = (process.env.APP_URL ?? 'http://localhost:3001').replace(/\/$/, '')

// Capture raw body BEFORE JSON parse — needed for JWS signature verification.
// JSON.stringify(req.body) after parse produces different bytes from the original.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    ;(req as FastifyRequest & { rawBody: string }).rawBody = body as string
    done(null, JSON.parse(body as string))
  } catch (err) {
    done(err as Error, undefined)
  }
})

// ─── Manifest ────────────────────────────────────────────────────────────────
app.get('/api/manifest', async () => construirManifiesto(APP_URL))

// ─── Register (EnvAPL) ───────────────────────────────────────────────────────
// Saleor hace POST del token aquí tras instalar la App. Sin guardia de registro,
// obviamente: es el endpoint que ENTREGA el token. El handler vive en
// lib/registro.ts y NO escribe el valor del token en el log — registra el evento
// y el origen. Un token en un log retenido es una credencial válida a la vista
// de cualquiera con acceso de lectura al panel de despliegue.
app.post('/api/register', manejadorRegistro)

// ─── Healthcheck ─────────────────────────────────────────────────────────────
// Sin guardia de registro a propósito: tiene que responder sobre todo cuando la
// App NO está registrada, que es cuando hace falta enterarse. Reporta
// `registered` para que un verde no pueda significar "viva pero incapaz de
// procesar un pago" sin que se note.
app.get('/api/health', manejadorSalud)
// Healthcheck de cadena (config + Saleor + JWKS). 503 si algo falla. Para
// monitoreo/alertas, no como liveness probe: ver lib/registro.ts.
app.get('/api/health/ready', manejadorListo)

// ─── UI ──────────────────────────────────────────────────────────────────────
app.get('/', async (_, reply) => {
  reply.type('text/html')
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Wompi — Licona</title>
  <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#F4EFE6;color:#1A1613}
  .box{text-align:center;padding:2rem;border:1px solid #ccc;border-radius:8px;background:#fff;max-width:380px}
  h1{margin:0 0 .5rem}p{margin:0;color:#666;font-size:.9rem}.badge{display:inline-block;margin-top:1rem;padding:.25rem .75rem;background:#1A1613;color:#fff;font-size:.75rem;border-radius:999px}</style></head>
  <body><div class="box">
    <h1>Wompi · Licona</h1>
    <p>Pasarela de pagos activa</p>
    <p style="margin-top:.5rem;font-size:.8rem;color:#999">Tarjeta · PSE · Nequi · Daviplata</p>
    <span class="badge">${process.env.WOMPI_SANDBOX !== 'false' ? 'Sandbox' : 'Producción'}</span>
  </div></body></html>`
})

// ─── Rutas que exigen App registrada ─────────────────────────────────────────
// Todo lo de aquí abajo necesita hablar con Saleor: los webhooks de pago se
// verifican contra Saleor y operan sobre sus transacciones, y el webhook
// entrante de Wompi termina en `transactionEventReport`. Sin `SALEOR_APP_TOKEN`
// ninguno puede completar su trabajo, así que responden 503 en vez de fallar a
// medias (ver lib/registro.ts para el porqué del código).
//
// `preHandler` y no un hook global: la lista de lo que se degrada tiene que
// quedar a la vista junto a las rutas, no escondida en una condición que haya
// que ir a leer a otro sitio para saber qué se sirve sin token.
const soloRegistrada = { preHandler: exigirAppRegistrada }

app.post('/api/webhooks/payment-gateway-initialize-session', soloRegistrada, paymentGatewayInitializeHandler)
app.post('/api/webhooks/transaction-initialize-session', soloRegistrada, transactionInitializeHandler)
app.post('/api/webhooks/transaction-process-session', soloRegistrada, transactionProcessHandler)
app.post('/api/webhooks/transaction-charge-requested', soloRegistrada, transactionChargeHandler)
app.post('/api/webhooks/transaction-refund-requested', soloRegistrada, transactionRefundHandler)
app.post('/api/webhooks/transaction-cancelation-requested', soloRegistrada, transactionCancelHandler)

// ─── Wompi incoming webhook ───────────────────────────────────────────────────
app.post('/api/webhooks/wompi-incoming', soloRegistrada, wompiIncomingHandler)

// ─── Conciliación contra el API de Wompi (B-412) — APAGADA por defecto ───────
// La ruta NO existe (404) salvo WOMPI_CONCILIACION_HABILITADA=true + WOMPI_CONCILIACION_TOKEN.
// Si está habilitada, un temporizador en proceso la dispara cada WOMPI_CONCILIACION_INTERVALO_MINUTOS
// (default 15; 0 = solo el endpoint HTTP). Ver lib/conciliacion-periodica.ts y docs/conciliacion.md.
let arrancarConciliacionPeriodica: (() => void) | null = null
let programadorConciliacion: ProgramadorConciliacion | null = null
if (conciliacionHabilitada()) {
  const cliente = wompiClient()
  const wompi = { listarTransacciones: (v: VentanaConsulta) => cliente.listTransactions(v.desde, v.hasta) }
  const saleor = { reportar: reportTransactionEvent }
  app.post('/api/conciliacion/ejecutar', soloRegistrada, crearHandlerConciliacion({ wompi, saleor }))
  app.log.warn('Conciliación Wompi HABILITADA: POST /api/conciliacion/ejecutar disponible con token')

  const { minutos, aviso } = intervaloDeConciliacion()
  if (aviso) app.log.warn(aviso)
  if (minutos === 0) {
    app.log.info('Conciliación periódica APAGADA (WOMPI_CONCILIACION_INTERVALO_MINUTOS=0): solo el endpoint HTTP')
  } else {
    const ventana = ventanaDeConciliacion()
    const ventanaMin = Math.round((ventana.hasta.getTime() - ventana.desde.getTime()) / 60_000)
    if (minutos > ventanaMin / 2) {
      app.log.warn(
        `Conciliación periódica: el intervalo (${minutos} min) supera la mitad de la ventana (${ventanaMin} min); ` +
          'una corrida fallida dejaría huecos sin cubrir',
      )
    }
    // Los hooks no se pueden añadir con el servidor ya escuchando: se registra aquí y detiene lo que haya.
    app.addHook('onClose', (_instancia, hecho) => {
      programadorConciliacion?.detener()
      hecho()
    })
    const logTimer = app.log.child({ webhook: 'conciliacion', disparador: 'timer' })
    arrancarConciliacionPeriodica = () => {
      programadorConciliacion = programarConciliacionPeriodica({
        conciliar: (v) => conciliarTransaccionesWompi({ wompi, saleor, ventana: v, log: logTimer }),
        ventana: () => ventanaDeConciliacion(),
        registrada: () => appRegistrada(),
        intervaloMs: minutos * 60_000,
        retrasoInicialMs: RETRASO_INICIAL_MS,
        log: logTimer,
      })
      app.log.warn(
        `Conciliación periódica ACTIVA: cada ${minutos} min, ventana ${ventanaMin} min, primera corrida en ${RETRASO_INICIAL_MS / 1000} s`,
      )
    }
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1) }

  // B-406: Saleor congela las suscripciones al instalar; si el manifiesto vivo ya
  // no coincide con lo instalado, se grita en el log (no repara, no bloquea).
  void comprobarDerivaDesdeManifiesto({
    obtenerWebhooksManifiesto: async () => (await app.inject('/api/manifest')).json().webhooks,
    saleorApiUrl: process.env.SALEOR_API_URL ?? '',
    appToken: process.env.SALEOR_APP_TOKEN ?? '',
    log: app.log,
    seguimiento: seguimientoDeriva,
  })

  // B-412: el temporizador de conciliación arranca con el servidor ya escuchando.
  arrancarConciliacionPeriodica?.()
})
