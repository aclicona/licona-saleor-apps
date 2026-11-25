/**
 * Respuesta HTTP no-2xx de Wompi. Lleva el `status` para que un handler pueda
 * distinguir un rechazo cierto (4xx de validación: la petición no se procesó)
 * de un estado desconocido (5xx, timeout, red), que NO es un rechazo.
 */
export class WompiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Cuerpo JSON de la respuesta de error, si lo hubo. Dato externo sin validar: solo para clasificar. */
    readonly cuerpo?: unknown,
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

/**
 * ¿Es el 422 «la referencia ya ha sido usada» al crear una transacción (B-1095)? Forma medida en sandbox el
 * 2026-10-09: `422 {"error":{"type":"INPUT_VALIDATION_ERROR","messages":{"reference":["La referencia ya ha sido usada"]}}}`.
 * Se reconoce por la CLAVE `messages.reference` (no por el texto, que es localizable), solo con status 422: un 422 por
 * otro campo (token de tarjeta, teléfono...) no la trae y sigue siendo un rechazo definitivo.
 */
export function esReferenciaDuplicada(error: unknown): boolean {
  if (!(error instanceof WompiHttpError) || error.status !== 422) return false
  const mensajes = (error.cuerpo as { error?: { messages?: Record<string, unknown> } } | null | undefined)?.error?.messages
  const ref = mensajes?.reference
  return Array.isArray(ref) ? ref.length > 0 : typeof ref === 'string' && ref.length > 0
}

const MAX_MOTIVO = 200

/**
 * Texto de validación que Wompi devuelve en un 4xx (`error.messages`: campo -> lista de textos), para
 * mostrárselo al operador (B-2524). Solo `campo: texto` de cadenas, sin más cuerpo, acotado a 200 caracteres.
 * Vacío si no es un rechazo definitivo o el cuerpo no trae mensajes: 5xx, timeouts y red siguen genéricos.
 */
export function motivoDeRechazo(error: unknown): string {
  if (!esRechazoDefinitivo(error)) return ''
  const mensajes = (error.cuerpo as { error?: { messages?: unknown } } | null | undefined)?.error?.messages
  if (!mensajes || typeof mensajes !== 'object' || Array.isArray(mensajes)) return ''
  const partes: string[] = []
  for (const [campo, valor] of Object.entries(mensajes as Record<string, unknown>)) {
    const textos = (Array.isArray(valor) ? valor : [valor]).filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (textos.length > 0) partes.push(`${campo}: ${textos.join(' ')}`)
  }
  const motivo = partes.join('; ')
  return motivo.length > MAX_MOTIVO ? `${motivo.slice(0, MAX_MOTIVO - 1)}…` : motivo
}
