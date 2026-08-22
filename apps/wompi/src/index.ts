import Fastify, { type FastifyRequest } from 'fastify'
import { paymentGatewayInitializeHandler } from './webhooks/payment-gateway-initialize.js'
import { transactionInitializeHandler } from './webhooks/transaction-initialize.js'
import { transactionProcessHandler } from './webhooks/transaction-process.js'
import { transactionChargeHandler } from './webhooks/transaction-charge.js'
import { transactionRefundHandler } from './webhooks/transaction-refund.js'
import { transactionCancelHandler } from './webhooks/transaction-cancel.js'
import { wompiIncomingHandler } from './webhooks/wompi-incoming.js'
import { verificarConfiguracionAlArranque } from './lib/config.js'

// Fail-fast ANTES de crear el servidor: sin las variables obligatorias el
// proceso no arranca. En un producto single-tenant replicable, una variable
// ausente es el fallo normal del aprovisionamiento y tiene que ser un deploy
// rojo — nunca una App que levanta aceptando pagos anónimos.
verificarConfiguracionAlArranque()

const app = Fastify({ logger: true })
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
app.get('/api/manifest', async () => ({
  id: 'app.licona.wompi',
  version: '1.0.0',
  name: 'Wompi (Bancolombia)',
  about: 'Pasarela de pagos Wompi: tarjetas, PSE, Nequi, Daviplata, Bancolombia Transfer.',
  permissions: ['HANDLE_PAYMENTS', 'HANDLE_CHECKOUTS'],
  appUrl: APP_URL,
  tokenTargetUrl: `${APP_URL}/api/register`,
  webhooks: [
    {
      name: 'Payment Gateway Initialize Session',
      syncEvents: ['PAYMENT_GATEWAY_INITIALIZE_SESSION'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/payment-gateway-initialize-session`,
      query: `subscription {
  event {
    ... on PaymentGatewayInitializeSession {
      sourceObject {
        ... on Checkout { id totalPrice { gross { amount currency } } }
      }
      data
      amount
    }
  }
}`,
    },
    {
      name: 'Transaction Initialize Session',
      syncEvents: ['TRANSACTION_INITIALIZE_SESSION'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/transaction-initialize-session`,
      query: `subscription {
  event {
    ... on TransactionInitializeSession {
      transaction { id pspReference }
      sourceObject {
        ... on Checkout {
          id
          email
          billingAddress { firstName lastName streetAddress1 city country { code } postalCode }
          totalPrice { gross { amount currency } }
        }
      }
      data
      action { amount currency }
    }
  }
}`,
    },
    {
      name: 'Transaction Process Session',
      syncEvents: ['TRANSACTION_PROCESS_SESSION'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/transaction-process-session`,
      query: `subscription {
  event {
    ... on TransactionProcessSession {
      transaction { id pspReference }
      action { amount }
      data
    }
  }
}`,
    },
    {
      name: 'Transaction Charge Requested',
      syncEvents: ['TRANSACTION_CHARGE_REQUESTED'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/transaction-charge-requested`,
      query: `subscription {
  event {
    ... on TransactionChargeRequested {
      transaction { id pspReference }
      action { amount }
    }
  }
}`,
    },
    {
      name: 'Transaction Refund Requested',
      syncEvents: ['TRANSACTION_REFUND_REQUESTED'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/transaction-refund-requested`,
      query: `subscription {
  event {
    ... on TransactionRefundRequested {
      transaction { id pspReference }
      action { amount }
    }
  }
}`,
    },
    {
      name: 'Transaction Cancelation Requested',
      syncEvents: ['TRANSACTION_CANCELATION_REQUESTED'],
      isActive: true,
      targetUrl: `${APP_URL}/api/webhooks/transaction-cancelation-requested`,
      query: `subscription {
  event {
    ... on TransactionCancelationRequested {
      transaction { id pspReference }
      action { amount }
    }
  }
}`,
    },
  ],
  extensions: [],
  requiredSaleorVersion: '>=3.22.0',
}))

// ─── Register (EnvAPL) ───────────────────────────────────────────────────────
// Saleor POSTs the auth token here after installation.
// Copy the token from Railway logs and set SALEOR_APP_TOKEN as env var.
app.post('/api/register', async (request, reply) => {
  const { auth_token } = request.body as { auth_token?: string }
  if (!auth_token) return reply.status(400).send({ error: 'Missing auth_token' })
  app.log.info(`SALEOR_APP_TOKEN=${auth_token}`)
  return reply.status(200).send({ success: true })
})

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

// ─── Saleor webhook routes ────────────────────────────────────────────────────
app.post('/api/webhooks/payment-gateway-initialize-session', paymentGatewayInitializeHandler)
app.post('/api/webhooks/transaction-initialize-session', transactionInitializeHandler)
app.post('/api/webhooks/transaction-process-session', transactionProcessHandler)
app.post('/api/webhooks/transaction-charge-requested', transactionChargeHandler)
app.post('/api/webhooks/transaction-refund-requested', transactionRefundHandler)
app.post('/api/webhooks/transaction-cancelation-requested', transactionCancelHandler)

// ─── Wompi incoming webhook ───────────────────────────────────────────────────
app.post('/api/webhooks/wompi-incoming', wompiIncomingHandler)

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1) }
})
