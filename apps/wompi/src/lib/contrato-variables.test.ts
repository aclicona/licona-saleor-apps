import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Contrato de VARIABLES de `transactionEventReport` (B-1327).
 *
 * `scripts/contrato-mutaciones/validar.py` (repo raíz de ecommerce) valida el DOCUMENTO GraphQL contra el
 * schema del fork, pero no los VALORES que la App manda en runtime. Un salto de Saleor que endurezca un
 * escalar o una validación de input (`PositiveDecimal`, `max_length` de `pspReference`, un enum nuevo...)
 * rompería el reporte en producción: cobro sin pedido. Aquí cada camino REAL que llama a la mutación —el
 * webhook entrante de Wompi, la conciliación de transacciones y el cierre de solicitudes pendientes— se
 * ejecuta con `graphql-request` mockeado, se captura lo que viajaría y se congela en
 * `contrato-variables/*.json`. El validador `scripts/contrato-variables/validar.py` pasa esos archivos por
 * el schema y las validaciones REALES del fork. Un cambio en cómo se construyen las variables cambia el
 * JSON y este test falla hasta que se revise (y se regenere con `vitest -u`) el contrato.
 *
 * Mismo patrón que `webhooks/contrato-respuestas.test.ts` (B-1303), que cubre las respuestas síncronas.
 */

const request = vi.fn()
vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...vals: unknown[]) => strings.reduce((a, s, i) => a + s + (vals[i] ?? ''), ''),
  GraphQLClient: class {
    request = request
  },
}))
// La firma se prueba a fondo en `wompi-signature.test.ts`; aquí solo importa lo que llega a Saleor.
vi.mock('./wompi-signature.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wompi-signature.js')>()),
  verificarFirmaWompi: () => ({ valido: true }),
}))

import { wompiIncomingHandler } from '../webhooks/wompi-incoming.js'
import { avisarRevisionHumana } from './aviso-revision-humana.js'
import { conciliarSolicitudesPendientes, politicaAnulaciones, politicaReembolsos } from './conciliacion-solicitudes.js'
import { conciliarTransaccionesWompi, type LogConciliacion } from './conciliacion.js'
import { reportTransactionEvent, type TransaccionConSolicitudes } from './saleor-client.js'
import type { WompiRefund, WompiTransaction } from './wompi-client.js'

const DIR_FIXTURES = fileURLToPath(new URL('../../contrato-variables/', import.meta.url))
const MUTACION = 'transactionEventReport'

/** ID global real de una `TransactionItem` (72 caracteres, medido contra el fork; ver `referencia.test.ts`). */
const REFERENCIA_SALEOR = 'VHJhbnNhY3Rpb25JdGVtOmEyMGVkNTc2LTNkOGMtNDliMi1iZGUzLTgwYzA3NmExNzUzYg=='
const PSP_WOMPI = '12084641-1791286722-99200'
const PSP_REEMBOLSO = '30954'
const CENTAVOS = 12_000_000 // 120.000 COP

const AHORA = new Date('2026-10-13T12:00:00Z')
const HACE_UNA_HORA = new Date(AHORA.getTime() - 61 * 60_000).toISOString() // pasado el margen de 60 min
const HACE_UN_MINUTO = new Date(AHORA.getTime() - 60_000).toISOString()

process.env.SALEOR_API_URL = 'https://saleor.test/graphql/'
process.env.SALEOR_APP_TOKEN = 'tok'

const silencio: LogConciliacion = { info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }

beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({
    transactionEventReport: { alreadyProcessed: false, transaction: { id: REFERENCIA_SALEOR }, errors: [] },
  })
})

// ─── Caminos que llaman a la mutación ────────────────────────────────────────

/** Webhook entrante de Wompi → `reportTransactionEvent` real. */
async function porWebhookEntrante(status: string): Promise<void> {
  const body = { event: 'transaction.updated', data: { transaction: { id: PSP_WOMPI, status, reference: REFERENCIA_SALEOR, amount_in_cents: CENTAVOS } } }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const reply = { status: () => reply, send: () => reply }
  await wompiIncomingHandler({ rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest, reply as unknown as FastifyReply)
}

/** Conciliación periódica de transacciones del listado de Wompi. */
async function porConciliacion(status: string): Promise<void> {
  const txn = { id: PSP_WOMPI, status, reference: REFERENCIA_SALEOR, amount_in_cents: CENTAVOS }
  await conciliarTransaccionesWompi({
    wompi: { listarTransacciones: () => Promise.resolve([txn]) },
    saleor: { reportar: reportTransactionEvent },
    ventana: { desde: new Date(AHORA.getTime() - 86_400_000), hasta: AHORA },
    log: silencio,
  })
}

const solicitud = (tipo: 'CANCEL_REQUEST' | 'REFUND_REQUEST', psp: string, importePendiente = 3000): TransaccionConSolicitudes => ({
  id: REFERENCIA_SALEOR,
  cancelPendingAmount: tipo === 'CANCEL_REQUEST' ? importePendiente : 0,
  refundPendingAmount: tipo === 'REFUND_REQUEST' ? importePendiente : 0,
  events: [{ type: tipo, pspReference: psp, createdAt: HACE_UNA_HORA, amount: 3000 }],
})

async function cerrarSolicitudes(
  tipo: 'CANCEL_REQUEST' | 'REFUND_REQUEST',
  psp: string,
  politica: ReturnType<typeof politicaAnulaciones>,
): Promise<void> {
  await conciliarSolicitudesPendientes({
    saleorLector: { listarTransaccionesConSolicitud: () => Promise.resolve([solicitud(tipo, psp)]) },
    saleor: { reportar: reportTransactionEvent },
    politica,
    ventana: { desde: new Date(AHORA.getTime() - 86_400_000), hasta: AHORA },
    ahora: AHORA,
    log: silencio,
  })
}

const txnWompi = (status: string): WompiTransaction => ({ id: PSP_WOMPI, status, amount_in_cents: 300_000 }) as unknown as WompiTransaction
const reembolsoWompi = (status: string): WompiRefund => ({ id: Number(PSP_REEMBOLSO), status, amount_in_cents: 300_000 }) as unknown as WompiRefund
const wompiReembolsos = (status: string) => ({
  getRefund: () => Promise.resolve(reembolsoWompi(status)),
  getTransaction: () => Promise.reject(new Error('no se consulta con id')),
})

interface Caso {
  caso: string
  ejecutar: () => Promise<void>
}

const CASOS: Caso[] = [
  // Webhook entrante: WOMPI_TO_SALEOR. VOIDED → CHARGE_FAILURE es deliberado (ver el comentario del mapa).
  { caso: 'webhook_aprobada', ejecutar: () => porWebhookEntrante('APPROVED') },
  { caso: 'webhook_rechazada', ejecutar: () => porWebhookEntrante('DECLINED') },
  { caso: 'webhook_error', ejecutar: () => porWebhookEntrante('ERROR') },
  { caso: 'webhook_anulada_voided', ejecutar: () => porWebhookEntrante('VOIDED') },

  // Conciliación de transacciones: mismo mapa, otro camino de código.
  { caso: 'conciliacion_aprobada', ejecutar: () => porConciliacion('APPROVED') },
  { caso: 'conciliacion_rechazada', ejecutar: () => porConciliacion('DECLINED') },

  // Cierre de solicitudes pendientes (B-1083 anulaciones, B-1077 reembolsos).
  { caso: 'reembolso_exito', ejecutar: () => cerrarSolicitudes('REFUND_REQUEST', PSP_REEMBOLSO, politicaReembolsos(wompiReembolsos('APPROVED'))) },
  { caso: 'reembolso_fallo', ejecutar: () => cerrarSolicitudes('REFUND_REQUEST', PSP_REEMBOLSO, politicaReembolsos(wompiReembolsos('DECLINED'))) },
  { caso: 'anulacion_exito', ejecutar: () => cerrarSolicitudes('CANCEL_REQUEST', PSP_WOMPI, politicaAnulaciones({ getTransaction: () => Promise.resolve(txnWompi('VOIDED')) })) },
  { caso: 'anulacion_fallo', ejecutar: () => cerrarSolicitudes('CANCEL_REQUEST', PSP_WOMPI, politicaAnulaciones({ getTransaction: () => Promise.resolve(txnWompi('APPROVED')) })) },

  // Aviso INFO de revisión humana: sin `availableActions` (es destructivo en Saleor) y con psp = clave del aviso.
  {
    caso: 'aviso_info_revision_humana',
    ejecutar: () =>
      avisarRevisionHumana(
        { transactionId: REFERENCIA_SALEOR, tipo: 'REFUND_REQUEST', motivo: 'pendiente-vencido', pspReference: PSP_REEMBOLSO, importeCop: 3000, eventos: [] },
        { saleor: { reportar: reportTransactionEvent }, log: silencio },
      ),
  },
]

/** Lo que viajaría a Saleor, tal como lo serializa JSON (una variable `undefined` no viaja). */
async function capturar(c: Caso): Promise<{ documento: string; variables: unknown }> {
  vi.useFakeTimers({ now: AHORA })
  try {
    await c.ejecutar()
  } finally {
    vi.useRealTimers()
  }
  expect(request, `${c.caso} debe llamar a la mutación exactamente una vez`).toHaveBeenCalledTimes(1)
  const { document, variables } = request.mock.calls[0][0] as { document: string; variables: unknown }
  return { documento: document.replace(/\s+/g, ' ').trim(), variables: JSON.parse(JSON.stringify(variables)) }
}

const archivo = (c: Pick<Caso, 'caso'>) => `${c.caso}.json`

describe('contrato de variables de transactionEventReport (B-1327)', () => {
  it.each(CASOS.map((c) => [archivo(c), c] as const))('%s', async (_nombre, c) => {
    const { documento, variables } = await capturar(c)
    const fixture = { mutacion: MUTACION, caso: c.caso, documento, variables }
    await expect(JSON.stringify(fixture, null, 2) + '\n').toMatchFileSnapshot(DIR_FIXTURES + archivo(c))
  })

  it('el aviso INFO no envía availableActions y el resto sí declara acciones', async () => {
    const info = await capturar(CASOS.find((c) => c.caso === 'aviso_info_revision_humana')!)
    expect(info.variables).not.toHaveProperty('availableActions')
    request.mockClear()
    const exito = await capturar(CASOS.find((c) => c.caso === 'webhook_aprobada')!)
    expect(exito.variables).toMatchObject({ type: 'CHARGE_SUCCESS', availableActions: ['REFUND'] })
  })

  it('no quedan fixtures huérfanas ni casos duplicados', () => {
    const esperados = CASOS.map(archivo)
    expect(new Set(esperados).size).toBe(esperados.length)
    expect(readdirSync(DIR_FIXTURES).sort()).toEqual([...esperados].sort())
  })
})
