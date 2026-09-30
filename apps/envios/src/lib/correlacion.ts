/**
 * Correlación de peticiones de la App de envíos.
 *
 * Gemelo reducido de apps/wompi/src/lib/correlacion.ts: mismo nombre canónico
 * (`checkoutId`) y mismas garantías. Aquí el payload de
 * SHIPPING_LIST_METHODS_FOR_CHECKOUT trae `checkout.id` (no `sourceObject`).
 *
 * Contrato: NUNCA lanza. Se llama antes de verificar la firma, así que el
 * cuerpo es de un tercero: un valor que no sea cadena o sea kilométrico se
 * descarta en vez de repetirse en cada línea de log.
 */

export interface CamposCorrelacion {
  checkoutId?: string
}

/** Mismo tope que la App wompi. */
export const LONGITUD_MAXIMA_VALOR = 512

export function camposDeCorrelacion(cuerpo: unknown): CamposCorrelacion {
  const checkout = typeof cuerpo === 'object' && cuerpo !== null ? (cuerpo as Record<string, unknown>).checkout : undefined
  const id = typeof checkout === 'object' && checkout !== null ? (checkout as Record<string, unknown>).id : undefined
  if (typeof id !== 'string') return {}
  const limpio = id.trim()
  if (!limpio || limpio.length > LONGITUD_MAXIMA_VALOR) return {}
  return { checkoutId: limpio }
}
