/**
 * Respuesta HTTP no-2xx de Wompi. Lleva el `status` para que un handler pueda
 * distinguir un rechazo cierto (4xx de validación: la petición no se procesó)
 * de un estado desconocido (5xx, timeout, red), que NO es un rechazo.
 */
export class WompiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WompiHttpError'
  }
}

/** 408/429 piden reintento: la petición pudo no procesarse, pero no es un rechazo definitivo. */
const ESTADOS_4XX_REINTENTABLES = new Set([408, 429])

/** ¿Es un 4xx que Wompi emite al rechazar la petición sin crear nada? */
export function esRechazoDefinitivo(error: unknown): error is WompiHttpError {
  return (
    error instanceof WompiHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    !ESTADOS_4XX_REINTENTABLES.has(error.status)
  )
}
