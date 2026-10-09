/**
 * Prueba de contrato contra el sandbox de Wompi (B-1100): lógica PURA de evaluación.
 *
 * La conciliación de reembolsos sin id (B-1097, `decision-reembolso.ts`) depende de dos hechos que NO están en la
 * doc pública de Wompi y se midieron en sandbox el 2026-10-09:
 *   1. `GET /transactions/{id}` trae `refunds[]` embebido (sin `id`), con `created_at`, `amount_in_cents`, `status`.
 *   2. El `created_at` de cada item embebido coincide con el de `GET /refunds/{id}` al milisegundo.
 * Y de una ausencia: no hay listados de reembolsos (404), por eso no se puede excluir por id.
 * Si Wompi cambia cualquiera, la exclusión de conocidos fallaría en silencio. Este módulo decide si el contrato se
 * mantiene; el script `scripts/contrato-sandbox.ts` hace las llamadas.
 *
 * Criterio de fechas: la conciliación compara `created_at` como epoch ms (`Date.parse`), nunca como string
 * (`refunds-embebidos.ts`). El contrato prueba exactamente eso: mismo `Date.parse`, no mismo texto. Una diferencia
 * solo de formato (`.345Z` vs `.345000Z`) NO rompe la conciliación y por tanto no es rojo.
 *
 * B-1121: `transaction-initialize` (B-1095) depende además de dos supuestos medidos en sandbox el 2026-10-09:
 *   4. `GET /transactions?reference=<ref>` FILTRA (propia -> 1, inexistente -> 0).
 *   5. Repetir una referencia da `422 {"error":{"messages":{"reference":[...]}}}` (lo que reconoce `esReferenciaDuplicada`).
 * Se evalúan en `evaluarReferencia`; el script usa el `WompiClient` real, así que se prueba el código de producción.
 */
import { esReferenciaDuplicada } from './wompi-error.js'

export type EstadoContrato = 'verde' | 'rojo' | 'sin_medida'

export interface ResultadoContrato {
  estado: EstadoContrato
  causas: string[]
}

/** Reembolso devuelto por `GET /refunds/{id}` (dato externo, sin validar). */
export interface RefundObservado {
  httpStatus: number
  data: unknown
}

export interface ObservacionContrato {
  /** Por qué no se pudo medir (red, tx no APPROVED, 401, llaves...). Si viene, el resultado es `sin_medida`. */
  noMedible?: string
  /** `data.refunds` de `GET /transactions/{id}` tal cual llegó. */
  refundsEmbebidos?: unknown
  /** `GET /refunds/{id}` de cada reembolso creado. */
  refunds?: RefundObservado[]
  /** HTTP de los listados que hoy responden 404 (`/refunds?transaction_id=`, `/transactions/{id}/refunds`). */
  listados?: { ruta: string; httpStatus: number }[]
}

export const CAUSA_LISTADO_DISPONIBLE = 'listado_disponible'

const PREFIJO_PRIVADA = 'prv_test_'
const PREFIJO_PUBLICA = 'pub_test_'

/** Guarda dura: el contrato solo corre con llaves de sandbox. Devuelve el motivo si NO se puede, o null. */
export function motivoLlavesNoSandbox(privada: string | undefined, publica: string | undefined): string | null {
  if (!privada || !publica) return 'llaves_ausentes'
  if (!privada.startsWith(PREFIJO_PRIVADA)) return 'llave_privada_no_sandbox'
  if (!publica.startsWith(PREFIJO_PUBLICA)) return 'llave_publica_no_sandbox'
  return null
}

interface ItemForma {
  creadoMs: number | null
  amount: number | null
  status: string | null
}

function leerItem(bruto: unknown): ItemForma | null {
  if (typeof bruto !== 'object' || bruto === null) return null
  const { created_at: creado, amount_in_cents: cents, status } = bruto as Record<string, unknown>
  const ms = typeof creado === 'string' ? Date.parse(creado) : NaN
  return {
    creadoMs: Number.isFinite(ms) ? ms : null,
    amount: typeof cents === 'number' && Number.isInteger(cents) ? cents : null,
    status: typeof status === 'string' ? status : null,
  }
}

export function evaluarContrato(obs: ObservacionContrato): ResultadoContrato {
  if (obs.noMedible) return { estado: 'sin_medida', causas: [obs.noMedible] }

  const causas: string[] = []

  // (3) Los listados deben seguir sin existir; si aparecen, se podría excluir por id: que alguien lo mire.
  for (const l of obs.listados ?? []) {
    if (l.httpStatus !== 404) causas.push(`${CAUSA_LISTADO_DISPONIBLE}:${l.ruta}:${l.httpStatus}`)
  }

  // Sin reembolsos creados no hay nada que comparar en (1)/(2) (el embebido vacío es lo esperado), pero un listado
  // que apareció (3) no se esconde tras un sin_medida.
  if ((obs.refunds ?? []).length === 0) {
    return causas.length ? { estado: 'rojo', causas } : { estado: 'sin_medida', causas: ['sin_refunds_que_comparar'] }
  }

  // (1) Forma de refunds[] embebido.
  if (!Array.isArray(obs.refundsEmbebidos)) {
    causas.push('refunds_embebido_ausente')
    return { estado: 'rojo', causas }
  }
  const embebidos = obs.refundsEmbebidos.map(leerItem)
  if (embebidos.length === 0) causas.push('refunds_embebido_vacio')
  embebidos.forEach((it, i) => {
    if (it === null || it.creadoMs === null) causas.push(`embebido_${i}_sin_created_at_valido`)
    if (it === null || it.amount === null) causas.push(`embebido_${i}_sin_amount_in_cents`)
    if (it === null || it.status === null) causas.push(`embebido_${i}_sin_status`)
  })

  // (2) Cada refund consultado por id debe tener exactamente un gemelo embebido (mismo ms y mismo importe).
  const refunds = obs.refunds ?? []
  refunds.forEach((r, i) => {
    const propio = r.httpStatus === 200 ? leerItem((r.data as { data?: unknown } | null)?.data) : null
    if (propio === null || propio.creadoMs === null || propio.amount === null) {
      causas.push(`refund_${i}_get_sin_created_at_valido(http ${r.httpStatus})`)
      return
    }
    const gemelos = embebidos.filter((e) => e && e.creadoMs === propio.creadoMs && e.amount === propio.amount)
    if (gemelos.length !== 1) causas.push(`refund_${i}_created_at_no_coincide_embebido(gemelos ${gemelos.length})`)
  })

  return { estado: causas.length ? 'rojo' : 'verde', causas }
}

/** Fila de transacción devuelta por la búsqueda por referencia (ya pasada por el refiltro del cliente). */
export interface FilaBusqueda {
  id: string
  reference: string
}

/**
 * Resultado de una búsqueda por referencia. `cliente` es lo que devuelve `WompiClient.findTransactionsByReference`
 * (con refiltro exacto); `crudasTotal`/`crudasAjenas` salen de la respuesta SIN refiltrar: el refiltro taparía un
 * filtro ignorado por Wompi mientras la propia siga en la primera página, y justo eso hay que vigilar.
 */
export interface BusquedaObservada {
  cliente: FilaBusqueda[]
  crudasTotal: number
  crudasAjenas: number
}

export interface ObservacionReferencia {
  noMedible?: string
  referencia?: string
  /** id de la transacción creada con `referencia`. */
  txId?: string
  /** Segundo `createTransaction` con la MISMA referencia: `creada: true` si Wompi lo aceptó; si no, el error lanzado. */
  repeticion?: { creada: boolean; error?: unknown }
  busquedaPropia?: BusquedaObservada
  busquedaInexistente?: BusquedaObservada
}

function evaluarBusqueda(nombre: 'propia' | 'inexistente', b: BusquedaObservada, esperadas: number, txId?: string): string[] {
  const causas: string[] = []
  if (b.crudasAjenas > 0) causas.push(`busqueda_${nombre}_filtro_ignorado(crudas ${b.crudasTotal}, ajenas ${b.crudasAjenas})`)
  if (b.cliente.length !== esperadas) causas.push(`busqueda_${nombre}_n=${b.cliente.length}`)
  else if (txId !== undefined && b.cliente.some((f) => f.id !== txId)) causas.push(`busqueda_${nombre}_id_ajeno`)
  return causas
}

export function evaluarReferencia(obs: ObservacionReferencia): ResultadoContrato {
  if (obs.noMedible) return { estado: 'sin_medida', causas: [obs.noMedible] }
  if (!obs.repeticion || !obs.busquedaPropia || !obs.busquedaInexistente) {
    return { estado: 'sin_medida', causas: ['observacion_referencia_incompleta'] }
  }
  const causas: string[] = []
  // (5) El rechazo de la referencia repetida debe seguir teniendo la forma que detecta producción.
  if (obs.repeticion.creada) causas.push('repeticion_aceptada')
  else if (!esReferenciaDuplicada(obs.repeticion.error)) causas.push('repeticion_no_es_referencia_duplicada')
  // (4) La búsqueda por referencia filtra de verdad.
  causas.push(...evaluarBusqueda('propia', obs.busquedaPropia, 1, obs.txId))
  causas.push(...evaluarBusqueda('inexistente', obs.busquedaInexistente, 0))
  return { estado: causas.length ? 'rojo' : 'verde', causas }
}

/** Une veredictos independientes: rojo gana a sin_medida, y sin_medida a verde. Las causas se concatenan. */
export function combinarResultados(resultados: readonly ResultadoContrato[]): ResultadoContrato {
  const causas = (e: EstadoContrato) => resultados.filter((r) => r.estado === e).flatMap((r) => r.causas)
  if (resultados.some((r) => r.estado === 'rojo')) return { estado: 'rojo', causas: causas('rojo') }
  if (resultados.some((r) => r.estado === 'sin_medida')) return { estado: 'sin_medida', causas: causas('sin_medida') }
  return { estado: 'verde', causas: [] }
}
