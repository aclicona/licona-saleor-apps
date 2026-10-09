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
 */

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
