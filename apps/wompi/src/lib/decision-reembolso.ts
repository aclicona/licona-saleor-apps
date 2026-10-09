import { centsToCop } from './money.js'
import { PLAZO_GLOBAL_MS } from './plazo.js'
import { refundsEmbebidos } from './refunds-embebidos.js'
import { esReferenciaSinId, transaccionDeReferenciaSinId } from './referencia-reembolso.js'
import { WompiHttpError } from './wompi-error.js'
import type { Decision, SolicitudPendiente } from './conciliacion-solicitudes.js'
import type { EventoTransaccionSaleor } from './saleor-client.js'
import type { WompiRefund, WompiTransaction } from './wompi-client.js'

/**
 * Decisión sobre reembolsos pendientes (B-1077, B-1097): tabla de estados compartida por el caso con id
 * (`GET /refunds/{id}`) y el casado sin id contra `refunds[]` de la transacción. Ver docs/conciliacion.md
 * § «Reembolsos sin id» (ruling de Fable, 2026-10-09).
 */

export const MENSAJE_REEMBOLSO_OK = 'Wompi: reembolso confirmado (APPROVED)'
const SUFIJO_SIN_ID = '; casado por importe y fecha, sin id'
const ESTADOS_REEMBOLSO_FALLIDO = new Set(['DECLINED', 'ERROR', 'VOIDED'])
/** Holgura de la ventana de casado: el request y el reembolso de Wompi no nacen en el mismo instante. */
const HOLGURA_CASADO_MS = 2 * 60_000

export interface ConsultorWompiReembolsos {
  getRefund(id: string): Promise<WompiRefund>
  getTransaction(id: string): Promise<WompiTransaction>
}

export function importeReembolsoCop(r: { amount_in_cents: number }): number | undefined {
  try {
    return centsToCop(r.amount_in_cents)
  } catch {
    return undefined
  }
}

/** APPROVED → éxito; DECLINED/ERROR/VOIDED → fallo (mensaje fijo, B-1061); PENDING en margen → esperar; resto → sin decidir. */
export function decisionPorEstado(
  estado: string,
  importeWompiCop: number | undefined,
  s: SolicitudPendiente,
  ahora: Date,
  margenMin: number,
  sufijo = '',
  auditoria?: Record<string, unknown>,
): Decision {
  if (estado === 'APPROVED') {
    return { tipo: 'exito', estadoWompi: estado, mensaje: MENSAJE_REEMBOLSO_OK + sufijo, importeWompiCop, auditoria }
  }
  if (ESTADOS_REEMBOLSO_FALLIDO.has(estado)) {
    return { tipo: 'fallo', estadoWompi: estado, mensaje: `Wompi no aprobó el reembolso (${estado})${sufijo}`, importeWompiCop, auditoria }
  }
  if (estado === 'PENDING' && dentroDelMargen(s, ahora, margenMin)) return { tipo: 'esperar', estadoWompi: estado }
  return { tipo: 'sin-decidir', estadoWompi: estado }
}

function dentroDelMargen(s: SolicitudPendiente, ahora: Date, margenMin: number): boolean {
  return ahora.getTime() - s.creadaEn.getTime() <= margenMin * 60_000
}

/** Decisión para un reembolso con id real: `GET /refunds/{id}`; 404 → sin decidir; otro error se propaga. */
export async function decidirReembolsoConId(
  wompi: Pick<ConsultorWompiReembolsos, 'getRefund'>,
  s: SolicitudPendiente,
  ahora: Date,
  margenMin: number,
): Promise<Decision> {
  let reembolso: WompiRefund
  try {
    reembolso = await wompi.getRefund(s.pspReference)
  } catch (error) {
    if (error instanceof WompiHttpError && error.status === 404) return { tipo: 'sin-decidir', estadoWompi: 'HTTP_404' }
    throw error
  }
  return decisionPorEstado(String(reembolso.status), importeReembolsoCop(reembolso), s, ahora, margenMin)
}

/** Psp con id real (no sin-id) de los eventos REFUND_* del mismo importe, deduplicados. */
function idsConocidos(eventos: EventoTransaccionSaleor[], importe: number): string[] {
  const ids = new Set<string>()
  for (const e of eventos) {
    if (!e.type.startsWith('REFUND_') || !e.pspReference || esReferenciaSinId(e.pspReference)) continue
    if (e.amount === importe) ids.add(e.pspReference)
  }
  return [...ids]
}

/** Requests sin-id aún abiertos (sin SUCCESS/FAILURE con el mismo psp) del mismo importe. */
function sinIdAbiertosDelImporte(eventos: EventoTransaccionSaleor[], importe: number): number {
  const cerrados = new Set(
    eventos.filter((e) => (e.type === 'REFUND_SUCCESS' || e.type === 'REFUND_FAILURE') && e.pspReference).map((e) => e.pspReference),
  )
  return eventos.filter(
    (e) =>
      e.type === 'REFUND_REQUEST' && e.pspReference && esReferenciaSinId(e.pspReference) &&
      !cerrados.has(e.pspReference) && e.amount === importe,
  ).length
}

/**
 * Casado de un request `<pspTx>:reembolso-sin-id:<uuid>` contra `refunds[]` de `GET /transactions/{pspTx}`.
 * Nunca se adivina: ambigüedad, conocido no consultable o 0 candidatos vencidos → sin decidir (revisión humana).
 */
export async function decidirReembolsoSinId(
  wompi: ConsultorWompiReembolsos,
  s: SolicitudPendiente,
  ahora: Date,
  margenMin: number,
): Promise<Decision> {
  const eventos = s.eventosTransaccion ?? []
  if (sinIdAbiertosDelImporte(eventos, s.importeCop) >= 2) return { tipo: 'sin-decidir', estadoWompi: 'SIN_ID_AMBIGUO' }
  const pspTx = transaccionDeReferenciaSinId(s.pspReference)
  if (!pspTx) return { tipo: 'sin-decidir', estadoWompi: 'SIN_ID' }

  let txn: WompiTransaction
  try {
    txn = await wompi.getTransaction(pspTx)
  } catch (error) {
    if (error instanceof WompiHttpError && error.status === 404) return { tipo: 'sin-decidir', estadoWompi: 'HTTP_404' }
    throw error
  }

  const desde = s.creadaEn.getTime() - HOLGURA_CASADO_MS
  const hasta = s.creadaEn.getTime() + PLAZO_GLOBAL_MS + HOLGURA_CASADO_MS
  let candidatos = refundsEmbebidos(txn).filter(
    (r) => importeReembolsoCop({ amount_in_cents: r.amountInCents }) === s.importeCop && r.creadoMs >= desde && r.creadoMs <= hasta,
  )
  if (candidatos.length === 0) {
    return dentroDelMargen(s, ahora, margenMin)
      ? { tipo: 'esperar', estadoWompi: 'SIN_CANDIDATOS' }
      : { tipo: 'sin-decidir', estadoWompi: 'SIN_CANDIDATOS' }
  }

  const conocidos = idsConocidos(eventos, s.importeCop)
  const excluidos: string[] = []
  for (const id of conocidos) {
    let conocido: WompiRefund
    try {
      conocido = await wompi.getRefund(id)
    } catch {
      return { tipo: 'sin-decidir', estadoWompi: 'CONOCIDO_NO_CONSULTABLE' }
    }
    const creadoMs = Date.parse(conocido.created_at ?? '')
    if (!Number.isFinite(creadoMs)) return { tipo: 'sin-decidir', estadoWompi: 'CONOCIDO_NO_CONSULTABLE' }
    const i = candidatos.findIndex((c) => c.creadoMs === creadoMs && c.amountInCents === conocido.amount_in_cents)
    if (i >= 0) {
      candidatos = candidatos.filter((_, j) => j !== i)
      excluidos.push(id)
    }
  }

  if (candidatos.length === 0) {
    return dentroDelMargen(s, ahora, margenMin)
      ? { tipo: 'esperar', estadoWompi: 'SIN_CANDIDATOS' }
      : { tipo: 'sin-decidir', estadoWompi: 'SIN_CANDIDATOS' }
  }
  if (candidatos.length > 1) return { tipo: 'sin-decidir', estadoWompi: 'CANDIDATOS_MULTIPLES' }

  const [unico] = candidatos
  const auditoria = {
    casadoSinId: { createdAt: new Date(unico.creadoMs).toISOString(), idsExcluidos: excluidos },
  }
  return decisionPorEstado(unico.status, s.importeCop, s, ahora, margenMin, SUFIJO_SIN_ID, auditoria)
}
