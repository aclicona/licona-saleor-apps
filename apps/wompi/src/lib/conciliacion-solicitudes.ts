import { centsToCop } from './money.js'
import { CODIGO_IMPORTE_INCONSISTENTE } from './saleor-errors.js'
import type { LogConciliacion, ReportadorSaleor, VentanaConsulta } from './conciliacion.js'
import type {
  EventoTransaccionSaleor,
  SaleorTransactionEventType,
  TipoSolicitud,
  TransaccionConSolicitudes,
} from './saleor-client.js'
import { esReferenciaSinId } from './referencia-reembolso.js'
import type { WompiTransaction } from './wompi-client.js'
import { decidirReembolsoConId, decidirReembolsoSinId, type ConsultorWompiReembolsos } from './decision-reembolso.js'

/**
 * Cierre de solicitudes que quedaron pendientes en Saleor (B-1083; reutilizable por B-1077).
 *
 * `transaction-cancel` / `transaction-refund` responden de forma asíncrona (sin `result`) cuando no saben
 * qué pasó en Wompi, y Saleor deja el `*_REQUEST` abierto (`cancelPendingAmount` / `refundPendingAmount` > 0).
 * Este motor consulta a Saleor por esas transacciones (no el listado de Wompi: la fecha del request no es
 * la de la transacción), pregunta a la política qué ocurrió en Wompi y cierra el request con
 * `*_SUCCESS`/`*_FAILURE`.
 *
 * Contrato con Saleor: el evento de cierre lleva el MISMO `pspReference` e importe que el request. Saleor
 * empareja por psp + familia; con otro importe devuelve INCORRECT_DETAILS en vez de `alreadyProcessed`.
 * Idempotencia: al cerrarse, la transacción deja de ser candidata y un duplicado da `alreadyProcessed`.
 * El motor NUNCA lanza. Los mensajes hacia Saleor son siempre fijos (nunca texto de error, B-1061).
 */

/** Cuánto se espera a que Wompi aplique una anulación (sigue APPROVED) antes de darla por fallida. */
export const MARGEN_ANULACION_PENDIENTE_MIN = 60

/** Cuánto se espera a que Wompi resuelva un reembolso PENDING antes de dejarlo para revisión humana. */
export const MARGEN_REEMBOLSO_PENDIENTE_MIN = 60

export interface LectorSolicitudesSaleor {
  /** Lanza si falla el transporte. `alLlegarAlTope` avisa que hubo más páginas de las que se leen. */
  listarTransaccionesConSolicitud(params: {
    tipo: TipoSolicitud
    desde: Date
    alLlegarAlTope?: () => void
  }): Promise<TransaccionConSolicitudes[]>
}

export interface ConsultorTransaccionWompi {
  getTransaction(id: string): Promise<WompiTransaction>
}


export interface SolicitudPendiente {
  transactionId: string
  pspReference: string
  importeCop: number
  creadaEn: Date
  /** Eventos de la transacción en Saleor: la política de reembolsos sin id los usa para excluir los conocidos (B-1097). */
  eventosTransaccion?: EventoTransaccionSaleor[]
}

export type Decision =
  | { tipo: 'exito'; estadoWompi: string; mensaje: string; importeWompiCop?: number; auditoria?: Record<string, unknown> }
  | { tipo: 'fallo'; estadoWompi: string; mensaje: string; importeWompiCop?: number; auditoria?: Record<string, unknown> }
  | { tipo: 'esperar'; estadoWompi: string }
  | { tipo: 'sin-decidir'; estadoWompi: string }

export interface PoliticaSolicitud {
  tipoRequest: TipoSolicitud
  tipoExito: SaleorTransactionEventType
  tipoFallo: SaleorTransactionEventType
  importePendiente(t: TransaccionConSolicitudes): number
  decidir(s: SolicitudPendiente, ahora: Date): Promise<Decision>
}

export interface ResultadoSolicitudes {
  candidatas: number
  cerradasExito: number
  cerradasFallo: number
  /** Saleor ya las tenía cerradas (`alreadyProcessed`). */
  yaCerradas: number
  /** Wompi aún no resuelve y el margen no vence. */
  enEspera: number
  /** Inconsistencia o estado inesperado: revisión humana. */
  sinDecidir: number
  errores: number
  /** La consulta a Saleor falló: no se revisó nada. */
  errorApi: boolean
}

const SUFIJOS_CIERRE: Record<string, string[]> = {
  CANCEL_REQUEST: ['CANCEL_SUCCESS', 'CANCEL_FAILURE'],
  REFUND_REQUEST: ['REFUND_SUCCESS', 'REFUND_FAILURE'],
}

/** Requests con psp que no tienen SUCCESS/FAILURE de la misma familia con el mismo psp. */
export function solicitudesSinResolver(t: TransaccionConSolicitudes, politica: PoliticaSolicitud) {
  const cierres = new Set(SUFIJOS_CIERRE[politica.tipoRequest])
  const cerrados = new Set(
    t.events.filter((e) => cierres.has(e.type) && e.pspReference).map((e) => e.pspReference),
  )
  return t.events.filter((e) => e.type === politica.tipoRequest && e.pspReference && !cerrados.has(e.pspReference))
}

type Contadores = ResultadoSolicitudes

async function cerrarSolicitud(
  s: SolicitudPendiente,
  deps: {
    saleor: ReportadorSaleor
    politica: PoliticaSolicitud
    ahora: Date
    log: LogConciliacion
    r: Contadores
  },
): Promise<void> {
  const { saleor, politica, ahora, log, r } = deps
  const campos = {
    pspReference: s.pspReference, transactionId: s.transactionId, tipo: politica.tipoRequest,
    importeCop: s.importeCop, creadaEn: s.creadaEn,
  }

  let decision: Decision
  try {
    decision = await politica.decidir(s, ahora)
  } catch (error) {
    r.errores++
    log.error({ ...campos, error }, 'Conciliación de solicitudes: no se pudo consultar Wompi; se sigue con las demás. La próxima corrida reintenta')
    return
  }

  const conEstado = { ...campos, estadoWompi: decision.estadoWompi }
  if (decision.tipo === 'esperar') {
    r.enEspera++
    log.info(conEstado, 'Conciliación de solicitudes: Wompi aún no resuelve; se espera al margen')
    return
  }
  if (decision.tipo === 'sin-decidir') {
    r.sinDecidir++
    log.error(conEstado, 'Conciliación de solicitudes: estado de Wompi inesperado para una solicitud pendiente. Requiere revisión humana')
    return
  }
  if (decision.importeWompiCop !== undefined && decision.importeWompiCop !== s.importeCop) {
    log.warn({ ...conEstado, importeWompiCop: decision.importeWompiCop }, 'Conciliación de solicitudes: el importe de Wompi difiere del de la solicitud; se reporta con el de la solicitud')
  }

  const type = decision.tipo === 'exito' ? politica.tipoExito : politica.tipoFallo
  try {
    const res = await saleor.reportar({
      transactionId: s.transactionId, type, amount: s.importeCop, pspReference: s.pspReference, message: decision.mensaje,
    })
    if (res.errors.length > 0) {
      r.errores++
      const fatal = res.errors.some((e) => e.code === CODIGO_IMPORTE_INCONSISTENTE)
      const registrar = fatal ? log.fatal : log.error
      registrar.call(log, { ...conEstado, errores: res.errors }, 'Conciliación de solicitudes: Saleor rechazó el cierre. Permanente — requiere revisión humana')
    } else if (res.alreadyProcessed) {
      r.yaCerradas++
    } else {
      if (decision.tipo === 'exito') r.cerradasExito++
      else r.cerradasFallo++
      log.warn({ ...conEstado, ...decision.auditoria, cierre: type }, 'Conciliación de solicitudes: se cerró una solicitud que había quedado pendiente en Saleor')
    }
  } catch (error) {
    r.errores++
    log.error({ ...conEstado, error }, 'Conciliación de solicitudes: no se pudo reportar a Saleor; se sigue con las demás. La próxima corrida reintenta')
  }
}

export async function conciliarSolicitudesPendientes(deps: {
  saleorLector: LectorSolicitudesSaleor
  saleor: ReportadorSaleor
  politica: PoliticaSolicitud
  ventana: VentanaConsulta
  ahora?: Date
  log: LogConciliacion
}): Promise<ResultadoSolicitudes> {
  const { saleorLector, saleor, politica, ventana, log } = deps
  const ahora = deps.ahora ?? new Date()
  const r: ResultadoSolicitudes = {
    candidatas: 0, cerradasExito: 0, cerradasFallo: 0, yaCerradas: 0, enEspera: 0, sinDecidir: 0, errores: 0, errorApi: false,
  }

  let transacciones: TransaccionConSolicitudes[]
  try {
    transacciones = await saleorLector.listarTransaccionesConSolicitud({
      tipo: politica.tipoRequest,
      desde: ventana.desde,
      alLlegarAlTope: () =>
        log.warn({ tipo: politica.tipoRequest }, 'Conciliación de solicitudes: se alcanzó el tope de páginas; puede haber solicitudes sin revisar'),
    })
  } catch (error) {
    r.errorApi = true
    log.error({ error, tipo: politica.tipoRequest }, 'Conciliación de solicitudes: Saleor falló al listar; no se revisó nada. La próxima corrida reintenta')
    return r
  }

  for (const t of transacciones) {
    if (politica.importePendiente(t) <= 0) continue
    r.candidatas++
    const abiertas = solicitudesSinResolver(t, politica)
    if (abiertas.length === 0) {
      r.sinDecidir++
      log.error({ transactionId: t.id, tipo: politica.tipoRequest }, 'Conciliación de solicitudes: pendiente sin request abierto: inconsistente, revisión humana')
      continue
    }
    for (const e of abiertas) {
      await cerrarSolicitud(
        { transactionId: t.id, pspReference: e.pspReference as string, importeCop: e.amount, creadaEn: new Date(e.createdAt), eventosTransaccion: t.events },
        { saleor, politica, ahora, log, r },
      )
    }
  }
  return r
}

const MENSAJE_ANULACION_OK = 'Wompi: anulación confirmada (VOIDED)'
const MENSAJE_ANULACION_FALLO = 'La anulación no se aplicó en Wompi (sigue APPROVED pasado el margen)'

function importeWompiCop(txn: WompiTransaction): number | undefined {
  try {
    return centsToCop(txn.amount_in_cents)
  } catch {
    return undefined
  }
}

/**
 * Política de anulaciones: VOIDED → éxito; APPROVED pasado el margen → fallo; APPROVED dentro del margen →
 * esperar; cualquier otro estado → sin decidir. Un VOIDED tardío tras un CANCEL_FAILURE sigue des-pagando
 * por el camino de `WOMPI_TO_SALEOR` (VOIDED → CHARGE_FAILURE), de ahí que el fallo por margen sea seguro.
 */
export function politicaAnulaciones(
  wompi: ConsultorTransaccionWompi,
  margenMin: number = MARGEN_ANULACION_PENDIENTE_MIN,
): PoliticaSolicitud {
  return {
    tipoRequest: 'CANCEL_REQUEST',
    tipoExito: 'CANCEL_SUCCESS',
    tipoFallo: 'CANCEL_FAILURE',
    importePendiente: (t) => t.cancelPendingAmount,
    async decidir(s, ahora) {
      const txn = await wompi.getTransaction(s.pspReference)
      const base = { estadoWompi: txn.status, importeWompiCop: importeWompiCop(txn) }
      if (txn.status === 'VOIDED') return { tipo: 'exito', mensaje: MENSAJE_ANULACION_OK, ...base }
      if (txn.status !== 'APPROVED') return { tipo: 'sin-decidir', estadoWompi: txn.status }
      const vencida = ahora.getTime() - s.creadaEn.getTime() > margenMin * 60_000
      if (!vencida) return { tipo: 'esperar', estadoWompi: txn.status }
      return { tipo: 'fallo', mensaje: MENSAJE_ANULACION_FALLO, ...base }
    },
  }
}

/**
 * Política de reembolsos (B-1077, B-1097). Con id: `GET /refunds/{id}`; APPROVED → éxito;
 * DECLINED/ERROR/VOIDED → fallo (mensaje fijo, nunca `status_message` de Wompi, B-1061); PENDING dentro del
 * margen → esperar; PENDING vencido u otro estado → sin decidir (un reembolso PENDING aún puede aprobarse, así
 * que NO se cierra como fallo). 404 → sin decidir. Un psp sin id (`:reembolso-sin-id:`) se casa contra
 * `refunds[]` de la transacción por importe y fecha (`decision-reembolso.ts`; Wompi no tiene listado de
 * reembolsos, confirmado en sandbox el 2026-10-09; ver docs/conciliacion.md § «Reembolsos sin id»).
 */
export function politicaReembolsos(
  wompi: ConsultorWompiReembolsos,
  margenMin: number = MARGEN_REEMBOLSO_PENDIENTE_MIN,
): PoliticaSolicitud {
  return {
    tipoRequest: 'REFUND_REQUEST',
    tipoExito: 'REFUND_SUCCESS',
    tipoFallo: 'REFUND_FAILURE',
    importePendiente: (t) => t.refundPendingAmount,
    decidir: (s, ahora) =>
      esReferenciaSinId(s.pspReference)
        ? decidirReembolsoSinId(wompi, s, ahora, margenMin)
        : decidirReembolsoConId(wompi, s, ahora, margenMin),
  }
}
