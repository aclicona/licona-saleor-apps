/**
 * URL del banco para PSE y BANCOLOMBIA_TRANSFER (B-2451).
 *
 * Wompi NO la devuelve en el POST de creación: aparece en `payment_method.extra.async_payment_url` al
 * consultar `GET /transactions/{id}`, unos segundos después. `redirect_url` es NUESTRA página de vuelta,
 * así que sin esta URL el comprador nunca llega al banco. Nunca lanza: si no hay URL se devuelve `sinUrl`
 * y el llamador degrada (la transacción ya existe, no es un fallo).
 */
import type { WompiTransaction } from './wompi-client.js'

export const INTERVALO_SONDEO_MS = 1000
export const TOPE_SONDEO_MS = 9000

export type ResultadoSondeo =
  | { tipo: 'url'; url: string }
  | { tipo: 'estadoFinal'; transaccion: WompiTransaction }
  | { tipo: 'sinUrl'; motivo: 'tiempo' | 'no-https' | 'error' }

interface Opciones {
  intervaloMs?: number
  topeMs?: number
  /** Inyectable para tests. */
  esperar?: (ms: number) => Promise<void>
  ahora?: () => number
}

const esperarReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function esHttps(valor: string): boolean {
  try {
    return new URL(valor).protocol === 'https:'
  } catch {
    return false
  }
}

export async function sondearUrlPagoAsincrono(
  consultar: (id: string, signal?: AbortSignal) => Promise<WompiTransaction>,
  id: string,
  signal: AbortSignal | undefined,
  opciones: Opciones = {},
): Promise<ResultadoSondeo> {
  const { intervaloMs = INTERVALO_SONDEO_MS, topeMs = TOPE_SONDEO_MS, esperar = esperarReal, ahora = Date.now } = opciones
  const limite = ahora() + topeMs
  for (;;) {
    if (signal?.aborted) return { tipo: 'sinUrl', motivo: 'tiempo' }
    try {
      const tx = await consultar(id, signal)
      const url = tx.payment_method?.extra?.async_payment_url
      if (typeof url === 'string' && url !== '') {
        return esHttps(url) ? { tipo: 'url', url } : { tipo: 'sinUrl', motivo: 'no-https' }
      }
      if (tx.status !== 'PENDING') return { tipo: 'estadoFinal', transaccion: tx }
    } catch {
      return { tipo: 'sinUrl', motivo: 'error' }
    }
    if (ahora() + intervaloMs >= limite) return { tipo: 'sinUrl', motivo: 'tiempo' }
    await esperar(intervaloMs)
  }
}
