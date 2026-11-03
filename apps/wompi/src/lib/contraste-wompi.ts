/**
 * Contraste de un evento entrante de Wompi con la fuente de verdad y ventana de frescura (B-1900).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * La firma de un evento (`wompi-signature.ts`) solo cubre los campos que el propio evento enumera en
 * `signature.properties`, y Wompi advierte que esa lista varía. Si no incluyera `transaction.reference`, un
 * evento firmado capturado podría reenviarse con OTRA `reference` y marcar como pagada otra orden del mismo
 * importe. Sin ventana de frescura, además, un evento firmado vale para siempre.
 *
 * Defensa: antes de reportar a Saleor se consulta `GET /transactions/{id}` con la llave privada y la transacción
 * real debe coincidir con el evento en id, reference, estado, importe y moneda. Esta capa no depende de qué
 * campos firme Wompi.
 */
import type { WompiTransaction } from './wompi-client.js'

/**
 * Antigüedad máxima aceptada de un evento (por su `timestamp` raíz, ya cubierto por la firma).
 *
 * Wompi reintenta los eventos no aceptados durante ~24 h (reintentos espaciados: ~30 min, ~3 h, ~24 h; dato de la
 * doc a confirmar). 72 h deja margen holgado sobre el último reintento sin dejar el replay abierto
 * indefinidamente. Un evento legítimo más viejo (caída larga nuestra) lo recupera la conciliación periódica.
 */
export const VENTANA_FRESCURA_EVENTO_MS = 72 * 60 * 60 * 1000

/** Tolerancia a relojes desfasados para eventos "del futuro". */
export const TOLERANCIA_RELOJ_FUTURO_MS = 10 * 60 * 1000

export type MotivoContraste =
  | 'ID_DISTINTO'
  | 'REFERENCE_DISTINTA'
  | 'ESTADO_DISTINTO'
  | 'IMPORTE_DISTINTO'
  | 'MONEDA_DISTINTA'
  | 'TRANSACCION_INEXISTENTE'

export interface TransaccionDeEvento {
  id: string
  status: string
  reference: string
  amount_in_cents: number
}

/**
 * ¿Está el evento dentro de la ventana? El `timestamp` es UNIX en segundos. Si el evento no trae un timestamp
 * numérico utilizable no se toma decisión (se conserva el comportamiento previo: la firma ya exige timestamp).
 */
export function eventoFresco(timestamp: unknown, ahoraMs: number = Date.now()): boolean {
  const segundos = typeof timestamp === 'string' && /^\d+$/.test(timestamp) ? Number(timestamp) : timestamp
  if (typeof segundos !== 'number' || !Number.isFinite(segundos)) return true
  const edadMs = ahoraMs - segundos * 1000
  return edadMs <= VENTANA_FRESCURA_EVENTO_MS && edadMs >= -TOLERANCIA_RELOJ_FUTURO_MS
}

/** Devuelve el primer motivo por el que la transacción real no respalda al evento, o `null` si coincide. */
export function motivoDeDiscrepancia(
  evento: TransaccionDeEvento,
  real: Pick<WompiTransaction, 'id' | 'status' | 'reference' | 'amount_in_cents' | 'currency'>,
): MotivoContraste | null {
  if (String(real.id) !== String(evento.id)) return 'ID_DISTINTO'
  if (real.reference !== evento.reference) return 'REFERENCE_DISTINTA'
  if (real.status !== evento.status) return 'ESTADO_DISTINTO'
  if (real.amount_in_cents !== evento.amount_in_cents) return 'IMPORTE_DISTINTO'
  // `centsToCop` asume COP: cualquier otra moneda reportada como COP sería un importe falso.
  if (real.currency !== 'COP') return 'MONEDA_DISTINTA'
  return null
}
