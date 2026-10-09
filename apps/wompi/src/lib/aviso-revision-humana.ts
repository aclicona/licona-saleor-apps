import type { LogConciliacion, ReportadorSaleor } from './conciliacion.js'
import type { EventoTransaccionSaleor, TipoSolicitud } from './saleor-client.js'

/**
 * Aviso INFO en la transacción de Saleor para lo que la conciliación deja «sin decidir» (B-1098).
 *
 * Hasta ahora esos casos solo morían en un `log.error` («revisión humana»). Este segundo canal deja un evento
 * `INFO` visible en la página del pedido del Dashboard. Hechos de Saleor 3.23 (ruling de Fable, 2026-10-09):
 * - Saleor NO deduplica `INFO` (`alreadyProcessed` nunca es true): el dedupe lo hace la app, mirando si los
 *   eventos de la transacción ya traen `{type:'INFO', pspReference: clave}`.
 * - `availableActions` es destructivo: el aviso NO lo envía (ni `[]`), o borraría el botón Refund.
 * - `INFO` no altera charged / refundPending / cancelPending ni fija el psp_reference de la transacción.
 * El aviso nunca lanza: si falla, `warn` y la próxima corrida reintenta (el `log.error` ya lo registró).
 */

export type MotivoRevision = 'pendiente-vencido' | 'no-encontrado' | 'estado-inesperado' | 'sin-request-abierto'

/**
 * Motivo del aviso a partir del `estadoWompi` de una decisión `sin-decidir` (la decisión no expone un motivo
 * propio). Determinista: `PENDING` (la política solo devuelve sin-decidir si venció el margen) → pendiente-vencido;
 * `HTTP_404` → no-encontrado; cualquier otro → estado-inesperado. El estado crudo de Wompi va solo al log.
 */
export function motivoDeEstadoWompi(estadoWompi: string): MotivoRevision {
  if (estadoWompi === 'PENDING') return 'pendiente-vencido'
  if (estadoWompi === 'HTTP_404') return 'no-encontrado'
  return 'estado-inesperado'
}

export interface AvisoRevisionHumana {
  transactionId: string
  tipo: TipoSolicitud
  motivo: MotivoRevision
  /** psp del request; ausente en «pendiente sin request abierto» (se usa el transactionId). */
  pspReference?: string
  importeCop: number
  eventos: EventoTransaccionSaleor[]
}

/** Clave estable del aviso (pspReference del INFO). Nunca el psp del cargo. */
export function claveAviso(a: Pick<AvisoRevisionHumana, 'tipo' | 'motivo' | 'pspReference' | 'transactionId'>): string {
  return `revision-humana:${a.tipo}:${a.motivo}:${a.pspReference ?? a.transactionId}`
}

function mensajeAviso(tipo: TipoSolicitud, motivo: MotivoRevision): string {
  const accion = tipo === 'CANCEL_REQUEST' ? 'anulación' : 'reembolso'
  return `Revisión humana: ${accion} sin resolver en Wompi (${motivo}). Este aviso no mueve dinero; ver logs de app-wompi`
}

export async function avisarRevisionHumana(
  aviso: AvisoRevisionHumana,
  deps: { saleor: ReportadorSaleor; log: LogConciliacion },
): Promise<void> {
  const clave = claveAviso(aviso)
  if (aviso.eventos.some((e) => e.type === 'INFO' && e.pspReference === clave)) return
  const campos = { transactionId: aviso.transactionId, tipo: aviso.tipo, motivo: aviso.motivo, clave }
  const fallo = 'Conciliación de solicitudes: no se pudo dejar el aviso en Saleor; el log ya lo registró. La próxima corrida reintenta'
  try {
    const res = await deps.saleor.reportar({
      transactionId: aviso.transactionId,
      type: 'INFO',
      amount: aviso.importeCop,
      pspReference: clave,
      message: mensajeAviso(aviso.tipo, aviso.motivo),
      availableActions: undefined,
    })
    if (res.errors.length > 0) deps.log.warn({ ...campos, errores: res.errors }, fallo)
  } catch (error) {
    deps.log.warn({ ...campos, error }, fallo)
  }
}
