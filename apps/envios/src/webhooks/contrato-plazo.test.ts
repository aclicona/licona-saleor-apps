// Contrato transversal (B-1080): «todo webhook síncrono responde dentro del plazo global».
// Gemelo del de Wompi (apps/wompi/src/webhooks/contrato-plazo.test.ts; ahí está la explicación completa).
// Aquí el único webhook síncrono es SHIPPING_LIST_METHODS_FOR_CHECKOUT, que NO llama a ningún servicio
// externo (cotiza en local con `cotizarEnvios`): su único tiempo de red es la verificación de la firma
// (JWKS, timeout de jose: 5 s). Si alguien le añade una llamada a un transportista, el test de la tabla
// obliga a declararla y a que respete el plazo; mientras tanto el handler responde a los ~5 s.
// Nota para quien lo haga: usar `crearPlazo()` de @licona/webhook-utils y pasar `plazo.signal` al fetch.
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
import { shippingListMethodsHandler } from './shipping-list-methods.js'

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

const JWKS_PEOR_CASO_MS = 5_000
/** Firma lenta (B-1105): el handler no añade tiempo propio a la verificación, así que no se suma nada. */
const FIRMA_LENTA_MS = 12_000

const HANDLERS: Record<string, Handler> = { shippingListMethodsHandler }

/** Clave = ruta del `targetUrl` del manifiesto. Un webhook síncrono nuevo sin entrada aquí rompe el test. */
const TABLA: Record<string, { handler: string; body: Record<string, unknown> }> = {
  '/api/webhooks/shipping-list-methods': {
    handler: 'shippingListMethodsHandler',
    body: { checkout: { id: 'C', shippingAddress: { city: 'Medellín', postalCode: '050001', countryArea: 'ANT' }, lines: [] } },
  },
}

/** Incumplimientos conocidos por ruta; el test exige que SIGAN ocurriendo hasta que se arreglen. Hoy ninguno. */
const EXCEPCIONES: Record<string, { reporte: string; motivo: string }> = {}

const manifiesto = webhooksSincronos(construirManifiesto('https://app.test').webhooks)
const indexTs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
const registrados: Record<string, string> = Object.fromEntries(
  [...indexTs.matchAll(/app\.post\(\s*'(\/api\/webhooks\/[^']+)'[^)]*?(\w+)\s*\)/g)].map((m) => [m[1], m[2]]),
)

async function respondeAlMs(handler: Handler, body: Record<string, unknown>, firmaMs = JWKS_PEOR_CASO_MS): Promise<number> {
  vi.mocked(verifySaleorWebhook).mockImplementation(() => new Promise<void>((res) => setTimeout(res, firmaMs)) as never)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const req = { rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest
  const t0 = Date.now()
  let al = Infinity
  const reply = { status: () => reply, send: () => ((al = Math.min(al, Date.now() - t0)), reply) }
  const promesa = handler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync()
  await promesa
  return al
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(verifySaleorWebhook).mockImplementation(() => new Promise<void>((res) => setTimeout(res, JWKS_PEOR_CASO_MS)) as never)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('contrato «los webhooks síncronos responden dentro del plazo» (B-1080)', () => {
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

  it('toda ruta /api/webhooks/ de index.ts es síncrona del manifiesto', () => {
    const sincronas = new Set(manifiesto.map((w) => w.ruta))
    expect(Object.keys(registrados).filter((r) => !sincronas.has(r))).toEqual([])
  })

  it('toda excepción corresponde a una ruta de la tabla y lleva reporte', () => {
    for (const [ruta, ex] of Object.entries(EXCEPCIONES)) {
      expect(TABLA, ruta).toHaveProperty(ruta)
      expect(ex.reporte, ruta).toMatch(/^B-\d+$/)
    }
  })

  for (const [ruta, entrada] of Object.entries(TABLA)) {
    const excepcion = EXCEPCIONES[ruta]
    if (!excepcion) {
      it(`${ruta} -> con la firma/JWKS lenta (${FIRMA_LENTA_MS} ms) responde dentro de ${PLAZO_WEBHOOK_SINCRONO_MS} ms (B-1105)`, async () => {
        expect(await respondeAlMs(HANDLERS[entrada.handler], entrada.body, FIRMA_LENTA_MS)).toBeLessThanOrEqual(PLAZO_WEBHOOK_SINCRONO_MS)
      })
      it(`${ruta} -> responde dentro de ${PLAZO_WEBHOOK_SINCRONO_MS} ms con la firma en su peor caso`, async () => {
        expect(await respondeAlMs(HANDLERS[entrada.handler], entrada.body)).toBeLessThanOrEqual(PLAZO_WEBHOOK_SINCRONO_MS)
      })
    } else {
      it(`${ruta} -> VIOLACIÓN CONOCIDA ${excepcion.reporte}: sigue ocurriendo (quita la excepción al arreglarla)`, async () => {
        expect(await respondeAlMs(HANDLERS[entrada.handler], entrada.body), excepcion.motivo).toBeGreaterThan(PLAZO_WEBHOOK_SINCRONO_MS)
      })
    }
  }
})
