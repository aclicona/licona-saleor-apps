// Contrato transversal (B-1061): «estado desconocido ≠ rechazo».
// Ver «Contrato» en docs/wompi-estados.md.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import { transactionInitializeHandler } from './transaction-initialize.js'
import { transactionProcessHandler } from './transaction-process.js'
import { transactionRefundHandler } from './transaction-refund.js'
import { transactionCancelHandler } from './transaction-cancel.js'
import { transactionChargeHandler } from './transaction-charge.js'

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

/** Llamadas del cliente de Wompi que un handler puede hacer. */
type Llamada = 'getAcceptanceToken' | 'createTransaction' | 'getTransaction' | 'refundTransaction' | 'getRefund' | 'voidTransaction'

interface Escenario {
  /** Llamada a Wompi que falla. */
  falla: Llamada
  /** Antes de este fallo la transacción/reembolso pudo haberse creado en Wompi. */
  puedeExistirEnWompi: boolean
}

interface Entrada {
  handler: Handler
  /** Cuerpo del webhook CON pspReference salvo que el handler no lo tenga aún. */
  body: Record<string, unknown>
  escenarios: Escenario[]
}

const TXN = { id: 'T', pspReference: '12084641-1791286722-99200' }
const ACTION = { amount: 3000, currency: 'COP' }

/** Un `pspReference` por handler, igual que en producción (initialize aún no lo tiene). */
const TABLA: Record<string, Entrada> = {
  'transaction-initialize': {
    handler: transactionInitializeHandler,
    body: { transaction: { id: 'T', pspReference: '' }, action: ACTION, data: { method: 'NEQUI', phone_number: '3001234567' } },
    escenarios: [
      { falla: 'getAcceptanceToken', puedeExistirEnWompi: false },
      { falla: 'createTransaction', puedeExistirEnWompi: true },
    ],
  },
  'transaction-process': {
    handler: transactionProcessHandler,
    body: { transaction: TXN, action: ACTION },
    escenarios: [{ falla: 'getTransaction', puedeExistirEnWompi: true }],
  },
  'transaction-refund': {
    handler: transactionRefundHandler,
    body: { transaction: TXN, action: ACTION },
    escenarios: [
      { falla: 'refundTransaction', puedeExistirEnWompi: true },
      // El reembolso ya existe en Wompi cuando falla el sondeo.
      { falla: 'getRefund', puedeExistirEnWompi: true },
    ],
  },
  'transaction-cancel': {
    handler: transactionCancelHandler,
    body: { transaction: TXN, action: ACTION },
    escenarios: [{ falla: 'voidTransaction', puedeExistirEnWompi: true }],
  },
  // No llama a Wompi: confirma sin red (Wompi captura al aprobar). Sin escenarios de fallo.
  'transaction-charge': {
    handler: transactionChargeHandler,
    body: { transaction: TXN, action: ACTION },
    escenarios: [],
  },
}

/** Violaciones conocidas: el test exige que SIGAN ocurriendo hasta que se arreglen. Hoy no hay ninguna. */
const EXCEPCIONES: Record<string, { reporte: string; motivo: string }> = {}

const TEXTO_ERROR = 'secreto-interno-xyz'
const FALLOS: Record<string, () => Error> = {
  AbortError: () => Object.assign(new Error(TEXTO_ERROR), { name: 'AbortError' }),
  TimeoutError: () => Object.assign(new Error(TEXTO_ERROR), { name: 'TimeoutError' }),
  'TypeError fetch failed': () => new TypeError(`fetch failed ${TEXTO_ERROR}`),
}

const ESTADO_PENDIENTE = { id: 30954, status: 'PENDING', transaction_id: 'x', amount_in_cents: 300000 }

function montarCliente(falla: Llamada, error: Error) {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v)
  const cliente: Record<Llamada, ReturnType<typeof vi.fn>> = {
    getAcceptanceToken: ok('tok'),
    createTransaction: ok({ id: 'w1', redirect_url: 'https://x' }),
    getTransaction: ok({ status: 'APPROVED' }),
    refundTransaction: ok(ESTADO_PENDIENTE),
    getRefund: ok(ESTADO_PENDIENTE),
    voidTransaction: ok({}),
  }
  cliente[falla] = vi.fn().mockRejectedValue(error)
  vi.mocked(wompiClient).mockReturnValue(cliente as unknown as ReturnType<typeof wompiClient>)
}

async function correr(entrada: Entrada) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const req = { rawBody: '{}', body: entrada.body, headers: {}, log } as unknown as FastifyRequest
  let payload: any
  const reply = { status: () => reply, send: (p: unknown) => ((payload = p), reply) }
  const promesa = entrada.handler(req, reply as unknown as FastifyReply)
  await vi.runAllTimersAsync()
  await promesa
  return payload as { result?: string; pspReference?: string; message?: string }
}

/** Motivos por los que la respuesta rompe el contrato (vacío = lo cumple). */
function violaciones(res: Awaited<ReturnType<typeof correr>>, esc: Escenario): string[] {
  const out: string[] = []
  if (esc.puedeExistirEnWompi && /_FAILURE$/.test(res.result ?? '')) out.push(`resultado final ${res.result}`)
  if ((res.message ?? '').includes(TEXTO_ERROR)) out.push('message filtra el texto del error')
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('contrato «estado desconocido ≠ rechazo» (B-1061)', () => {
  it('la tabla cubre todos los transaction-*.ts del directorio', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const enDisco = readdirSync(dir)
      .filter((f) => /^transaction-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort()
    expect(Object.keys(TABLA).sort()).toEqual(enDisco)
  })

  it('toda excepción corresponde a un handler de la tabla y lleva reporte', () => {
    for (const [nombre, ex] of Object.entries(EXCEPCIONES)) {
      expect(TABLA, nombre).toHaveProperty(nombre)
      expect(ex.reporte, nombre).toMatch(/^(B-\d+)$/)
    }
  })

  for (const [nombre, entrada] of Object.entries(TABLA)) {
    const excepcion = EXCEPCIONES[nombre]
    for (const esc of entrada.escenarios) {
      for (const [tipo, crear] of Object.entries(FALLOS)) {
        const titulo = `${nombre}: ${esc.falla} lanza ${tipo}`
        if (!excepcion) {
          it(`${titulo} -> no responde fallo final ni filtra el error`, async () => {
            montarCliente(esc.falla, crear())
            const res = await correr(entrada)
            expect(violaciones(res, esc)).toEqual([])
          })
        } else {
          it(`${titulo} -> VIOLACIÓN CONOCIDA ${excepcion.reporte}: sigue ocurriendo (quita la excepción al arreglarla)`, async () => {
            montarCliente(esc.falla, crear())
            const res = await correr(entrada)
            expect(violaciones(res, esc), excepcion.motivo).not.toEqual([])
          })
        }
      }
    }
  }
})
