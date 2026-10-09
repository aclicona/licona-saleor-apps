// Contrato transversal (B-1080): «todo webhook síncrono responde dentro del plazo global».
//
// Saleor espera 18 s la respuesta de un webhook síncrono (WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT del fork).
// B-1078 puso un plazo de 15 s en el reembolso, pero dependía de que cada handler se acordara de aplicarlo.
// Este test lo exige de TODOS: para cada webhook síncrono del manifiesto, con la verificación de la firma
// en su peor caso (5 s de JWKS) y un Wompi que nunca responde, la respuesta llega dentro de
// PLAZO_WEBHOOK_SINCRONO_MS (15 s) contados desde la llegada, y si lo que se colgó pudo haberse creado en
// Wompi, no es un `*_FAILURE` (resultado final: invita a reintentar y duplicar). Un fallo CIERTO antes de
// crear nada (p. ej. el acceptance token) sí puede ser CHARGE_FAILURE: la regla de «estado desconocido ≠
// rechazo» (contrato-desconocido.test.ts) es la misma. Ver «Contrato» en docs/wompi-estados.md.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))

import { PLAZO_WEBHOOK_SINCRONO_MS, verifySaleorWebhook, webhooksSincronos } from '@licona/webhook-utils'
import { construirManifiesto } from '../manifest.js'
import { wompiClient } from '../lib/wompi-client.js'
import { paymentGatewayInitializeHandler } from './payment-gateway-initialize.js'
import { transactionInitializeHandler } from './transaction-initialize.js'
import { transactionProcessHandler } from './transaction-process.js'
import { transactionChargeHandler } from './transaction-charge.js'
import { transactionRefundHandler } from './transaction-refund.js'
import { transactionCancelHandler } from './transaction-cancel.js'

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

/** Peor caso de la verificación de firma: la descarga del JWKS (timeout de jose). */
const JWKS_PEOR_CASO_MS = 5_000
/** Saleor corta a los 18 s: el contrato exige 15 s (el plazo) y deja ese margen. */
const SALEOR_ESPERA_MS = 18_000

/** Un escenario: qué petición a Wompi se cuelga (nunca responde) y si lo creado allí pudo existir ya. */
interface Escenario {
  cuelga: RegExp
  /** Antes de colgarse, ¿pudo haberse creado la transacción/reembolso/anulación en Wompi? */
  puedeExistirEnWompi: boolean
}

interface Entrada {
  /** Nombre del handler tal como lo registra `src/index.ts`. */
  handler: string
  body: Record<string, unknown>
  escenarios: Escenario[]
}

const TXN = { id: 'T', pspReference: '12084641-1791286722-99200' }
const ACTION = { amount: 3000, currency: 'COP' }

const HANDLERS: Record<string, Handler> = {
  paymentGatewayInitializeHandler,
  transactionInitializeHandler,
  transactionProcessHandler,
  transactionChargeHandler,
  transactionRefundHandler,
  transactionCancelHandler,
}

/** Clave = ruta del `targetUrl` del manifiesto. Un webhook síncrono nuevo sin entrada aquí rompe el test. */
const TABLA: Record<string, Entrada> = {
  '/api/webhooks/payment-gateway-initialize-session': {
    handler: 'paymentGatewayInitializeHandler',
    body: { data: {} },
    // No llama a Wompi: solo debe responder tras la verificación.
    escenarios: [], // solo el escenario «se cuelga todo», que se añade solo
  },
  '/api/webhooks/transaction-initialize-session': {
    handler: 'transactionInitializeHandler',
    body: { transaction: { id: 'T', pspReference: '' }, action: ACTION, data: { method: 'NEQUI', phone_number: '3001234567' } },
    escenarios: [
      { cuelga: /\/merchants\//, puedeExistirEnWompi: false },
      { cuelga: /\/transactions$/, puedeExistirEnWompi: true },
    ],
  },
  '/api/webhooks/transaction-process-session': {
    handler: 'transactionProcessHandler',
    body: { transaction: TXN, action: ACTION },
    escenarios: [{ cuelga: /\/transactions\//, puedeExistirEnWompi: true }],
  },
  // No llama a Wompi: confirma sin red (Wompi captura al aprobar).
  '/api/webhooks/transaction-charge-requested': {
    handler: 'transactionChargeHandler',
    body: { transaction: TXN, action: ACTION },
    escenarios: [], // solo el escenario «se cuelga todo», que se añade solo
  },
  '/api/webhooks/transaction-refund-requested': {
    handler: 'transactionRefundHandler',
    body: { transaction: TXN, action: ACTION },
    escenarios: [
      { cuelga: /\/refunds$/, puedeExistirEnWompi: true },
      // El reembolso ya existe en Wompi cuando se cuelga el sondeo.
      { cuelga: /\/refunds\//, puedeExistirEnWompi: true },
    ],
  },
  '/api/webhooks/transaction-cancelation-requested': {
    handler: 'transactionCancelHandler',
    body: { transaction: TXN, action: ACTION },
    escenarios: [{ cuelga: /\/void$/, puedeExistirEnWompi: true }],
  },
}

/**
 * Escenario «se cuelga todo»: Wompi no responde a NINGUNA petición. Se añade solo a cada handler de la
 * tabla (ver `escenariosDe`), así un handler nuevo, o una llamada nueva dentro de uno existente que no
 * reciba `plazo.signal`, no se escapa por no coincidir con el regex de un escenario concreto.
 * Solo exige el TIEMPO (respuesta dentro del plazo): `puedeExistirEnWompi: false`, porque la primera
 * llamada de cada handler es la que se cuelga y en initialize esa es el acceptance token, donde un
 * CHARGE_FAILURE cierto es legítimo. Que no haya *_FAILURE tras crear algo lo cubren los escenarios
 * concretos de cada entrada.
 */
const SE_CUELGA_TODO: Escenario = { cuelga: /./, puedeExistirEnWompi: false }
const escenariosDe = (e: Entrada): Escenario[] => [...e.escenarios, SE_CUELGA_TODO]

/**
 * Incumplimientos conocidos, por ruta. El test exige que SIGAN ocurriendo: cuando uno se arregla, falla
 * hasta que se quita de aquí. Hoy no hay ninguno (initialize, que arrastraba B-1060, ya usa el plazo).
 */
const EXCEPCIONES: Record<string, { reporte: string; motivo: string }> = {}

/** Rutas `/api/webhooks/*` de index.ts que NO son webhooks síncronos de Saleor (entrantes de Wompi, etc.). */
const NO_SINCRONOS = new Set(['/api/webhooks/wompi-incoming'])

const OK: Array<[RegExp, string, unknown]> = [
  [/\/merchants\//, 'GET', { data: { presigned_acceptance: { acceptance_token: 'tok' } } }],
  [/\/transactions$/, 'POST', { data: { id: 'w1', redirect_url: 'https://x' } }],
  [/\/transactions\/[^/]+\/void$/, 'POST', { data: {} }],
  [/\/transactions\//, 'GET', { data: { status: 'APPROVED' } }],
  [/\/refunds$/, 'POST', { data: { id: 77, status: 'PENDING', transaction_id: 'x', amount_in_cents: 300000 } }],
  [/\/refunds\//, 'GET', { data: { id: 77, status: 'PENDING', transaction_id: 'x', amount_in_cents: 300000 } }],
]

/** `fetch` falso: lo que coincide con `cuelga` nunca responde (solo termina si lo aborta una señal). */
function montarRed(cuelga: RegExp) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      if (cuelga.test(url)) {
        return new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason)))
      }
      const metodo = init.method ?? 'GET'
      const ok = OK.find(([re, m]) => re.test(url) && m === metodo)
      return Promise.resolve(new Response(JSON.stringify(ok?.[2] ?? {}), { status: 200 }))
    }),
  )
}

/** `AbortSignal.timeout` real usa un reloj interno que los fake timers no controlan: se emula con ellos. */
function emularTimeoutDeSenal() {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms)
    return ac.signal
  })
}

interface Medida {
  respuestaAlMs: number
  result?: string
  message?: string
}

async function medir(handler: Handler, body: Record<string, unknown>): Promise<Medida> {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const req = { rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest
  const t0 = Date.now()
  let medida: Medida | undefined
  const reply = {
    status: () => reply,
    send: (p: { result?: string; message?: string }) => {
      medida ??= { respuestaAlMs: Date.now() - t0, result: p?.result, message: p?.message }
      return reply
    },
  }
  const promesa = handler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync()
  await promesa
  return medida ?? { respuestaAlMs: Infinity }
}

/** Motivos por los que el handler rompe el contrato (vacío = lo cumple). */
async function violacionesDePlazo(handler: Handler, body: Record<string, unknown>, esc: Escenario): Promise<string[]> {
  montarRed(esc.cuelga)
  const m = await medir(handler, body)
  const out: string[] = []
  if (m.respuestaAlMs > PLAZO_WEBHOOK_SINCRONO_MS) {
    const aviso = m.respuestaAlMs > SALEOR_ESPERA_MS ? ' (Saleor ya habría dado por fallida la entrega)' : ''
    out.push(`respondió a los ${m.respuestaAlMs} ms, plazo ${PLAZO_WEBHOOK_SINCRONO_MS} ms${aviso}`)
  }
  if (esc.puedeExistirEnWompi && /_FAILURE$/.test(m.result ?? '')) out.push(`resultado final ${m.result} con estado desconocido`)
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  emularTimeoutDeSenal()
  process.env.WOMPI_PUBLIC_KEY = 'pub_test'
  process.env.WOMPI_PRIVATE_KEY = 'prv_test'
  process.env.WOMPI_INTEGRITY_KEY = 'int_test'
  // La verificación de firma tarda lo máximo que tarda hoy (descarga del JWKS) y luego acepta.
  vi.mocked(verifySaleorWebhook).mockImplementation(
    () => new Promise<void>((res) => setTimeout(res, JWKS_PEOR_CASO_MS)) as never,
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const manifiesto = webhooksSincronos(construirManifiesto('https://app.test').webhooks)
const indexTs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
/** `app.post('<ruta>', ..., <handler>)` de index.ts → { ruta: nombreDelHandler }. */
const registrados: Record<string, string> = Object.fromEntries(
  [...indexTs.matchAll(/app\.post\(\s*'(\/api\/webhooks\/[^']+)'[^)]*?(\w+)\s*\)/g)].map((m) => [m[1], m[2]]),
)

describe('contrato «los webhooks síncronos responden dentro del plazo» (B-1080)', () => {
  it('el plazo compartido deja margen bajo los 18 s de Saleor', () => {
    expect(PLAZO_WEBHOOK_SINCRONO_MS).toBeLessThan(SALEOR_ESPERA_MS)
  })

  it('cada webhook síncrono del manifiesto está en la tabla (y la tabla no tiene rutas huérfanas)', () => {
    const rutas = manifiesto.map((w) => w.ruta)
    expect({
      sinCubrir: rutas.filter((r) => !(r in TABLA)),
      huerfanas: Object.keys(TABLA).filter((r) => !rutas.includes(r)),
    }).toEqual({ sinCubrir: [], huerfanas: [] })
  })

  it('cada ruta síncrona está registrada en index.ts con el handler de la tabla', () => {
    for (const [ruta, entrada] of Object.entries(TABLA)) {
      expect(registrados[ruta], ruta).toBe(entrada.handler)
      expect(HANDLERS, ruta).toHaveProperty(entrada.handler)
    }
  })

  it('toda ruta /api/webhooks/ de index.ts es síncrona del manifiesto o está declarada como no síncrona', () => {
    const sincronas = new Set(manifiesto.map((w) => w.ruta))
    const sueltas = Object.keys(registrados).filter((r) => !sincronas.has(r) && !NO_SINCRONOS.has(r))
    expect(sueltas).toEqual([])
  })

  it('toda excepción corresponde a una ruta de la tabla y lleva reporte', () => {
    for (const [ruta, ex] of Object.entries(EXCEPCIONES)) {
      expect(TABLA, ruta).toHaveProperty(ruta)
      expect(ex.reporte, ruta).toMatch(/^B-\d+$/)
    }
  })

  for (const [ruta, entrada] of Object.entries(TABLA)) {
    const excepcion = EXCEPCIONES[ruta]
    escenariosDe(entrada).forEach((esc, i) => {
      const titulo = `${ruta} [se cuelga ${esc.cuelga}]`
      if (!excepcion) {
        it(`${titulo} -> responde dentro del plazo y sin fallo final espurio`, async () => {
          const v = await violacionesDePlazo(HANDLERS[entrada.handler], entrada.body, esc)
          expect(v).toEqual([])
        })
      } else if (i === 0) {
        it(`${ruta} -> VIOLACIÓN CONOCIDA ${excepcion.reporte}: sigue ocurriendo (quita la excepción al arreglarla)`, async () => {
          const todas: string[] = []
          for (const e of escenariosDe(entrada)) todas.push(...(await violacionesDePlazo(HANDLERS[entrada.handler], entrada.body, e)))
          expect(todas, excepcion.motivo).not.toEqual([])
        })
      }
    })
  }
})

describe('el verificador detecta un handler que se pasa del plazo (meta-test)', () => {
  const body = { transaction: TXN, action: ACTION }
  const esc: Escenario = { cuelga: /\/transactions\//, puedeExistirEnWompi: true }

  /** Juguete: dos llamadas encadenadas SIN plazo global; cada una solo tiene su timeout propio de 15 s. */
  const dosLlamadasSinPlazo: Handler = async (_req, reply) => {
    await vi.mocked(verifySaleorWebhook)('{}', '', '')
    for (let i = 0; i < 2; i++) await wompiClient().getTransaction('x').catch(() => undefined)
    return reply.send({ pspReference: 'x' })
  }

  it('dos llamadas de 15 s encadenadas rompen el contrato', async () => {
    const v = await violacionesDePlazo(dosLlamadasSinPlazo, body, esc)
    expect(v.join(' ')).toMatch(/respondió a los 35000 ms/)
    expect(v.join(' ')).toMatch(/Saleor ya habría dado por fallida/)
  })

  it('un handler que responde FAILURE final con estado desconocido rompe el contrato', async () => {
    const toy: Handler = async (_req, reply) => reply.send({ result: 'REFUND_FAILURE' })
    expect(await violacionesDePlazo(toy, body, esc)).toEqual(['resultado final REFUND_FAILURE con estado desconocido'])
  })

  it('un handler que acota todo con el plazo compartido lo cumple', async () => {
    const { crearPlazo } = await import('@licona/webhook-utils')
    const conPlazo: Handler = async (_req, reply) => {
      const plazo = crearPlazo()
      try {
        await vi.mocked(verifySaleorWebhook)('{}', '', '')
        const cliente = wompiClient() as unknown as { getTransaction: (id: string, p?: AbortSignal) => Promise<unknown> }
        for (let i = 0; i < 2; i++) await cliente.getTransaction('x', plazo.signal)
        return reply.send({ result: 'CHARGE_SUCCESS' })
      } catch {
        return reply.send({ pspReference: 'x' })
      } finally {
        plazo.limpiar()
      }
    }
    expect(await violacionesDePlazo(conPlazo, body, esc)).toEqual([])
  })
})
