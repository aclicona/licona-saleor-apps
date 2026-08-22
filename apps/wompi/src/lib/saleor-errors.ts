/**
 * Clasificación de fallos al reportar un evento a Saleor.
 *
 * El criterio, y el único que hay que aplicar, es este:
 *
 *   ¿un reintento IDÉNTICO mañana puede tener éxito sin que cambie el payload?
 *     sí  → el fallo es TRANSITORIO (o de operación) → responder 5xx a Wompi
 *     no  → el fallo es PERMANENTE                    → responder 2xx + log ruidoso
 *
 * Por qué importa: el reintento de Wompi *es* la cola de esta App y la
 * idempotencia *es* de Saleor (`transactionEventReport` deduplica del lado
 * servidor por `pspReference` + `type` + importe, dentro de una transacción
 * con `select_for_update`). No hay cola propia, ni contadores, ni backoff, ni
 * cache de eventos vistos. Un 200 le dice a Wompi "entregado, no reintentes":
 * darlo cuando el evento NO llegó a Saleor pierde la confirmación de un pago
 * real. Un 500 en un fallo permanente, al revés, condena a Wompi a reintentar
 * para siempre un evento que nunca va a converger.
 *
 * Este módulo vive separado de `saleor-client.ts` a propósito: el test del
 * handler mockea el cliente entero, y la clasificación tiene que seguir siendo
 * el código real bajo prueba.
 */

/**
 * - `TRANSITORIO`: Saleor no estuvo disponible (caída, timeout, red, 5xx, 429).
 *   El reintento converge solo, sin intervención. → 500.
 * - `AUTENTICACION`: el token de la App no sirve (401/403, permiso denegado).
 *   El evento es válido y la instancia está rota; un humano rota el token y el
 *   siguiente reintento entra. También → 500, pero el log tiene que gritar que
 *   hace falta intervención humana, porque el reintento NO converge solo.
 */
export type ClasificacionFalloSaleor = 'TRANSITORIO' | 'AUTENTICACION'

/** Códigos de error de negocio de `transactionEventReport` que tratamos explícitamente. */
export const CODIGO_IMPORTE_INCONSISTENTE = 'INCORRECT_DETAILS'
export const CODIGO_TRANSACCION_INEXISTENTE = 'NOT_FOUND'

/**
 * Códigos que Saleor devuelve en las extensiones de un error GraphQL de nivel
 * superior cuando el problema es de autenticación/autorización. Saleor
 * responde HTTP 200 con estos, así que el status no basta para detectarlos.
 */
const CODIGOS_AUTENTICACION = new Set(['PermissionDenied', 'ExpiredSignatureError', 'JWTError', 'InvalidSignature'])

interface ErrorConRespuestaHttp {
  response?: { status?: unknown; errors?: unknown }
}

/**
 * Extrae el status HTTP de un `ClientError` de graphql-request.
 * Se hace por duck-typing y no con `instanceof ClientError` porque el error
 * puede venir de otra instancia del módulo (pnpm, mocks de test) y un
 * `instanceof` fallido degradaría silenciosamente la clasificación.
 */
function statusHttpDe(error: unknown): number | undefined {
  const status = (error as ErrorConRespuestaHttp)?.response?.status
  return typeof status === 'number' ? status : undefined
}

/** Detecta el código de excepción de Saleor dentro de los errores GraphQL de nivel superior. */
function tieneCodigoDeAutenticacion(error: unknown): boolean {
  const errores = (error as ErrorConRespuestaHttp)?.response?.errors
  if (!Array.isArray(errores)) return false

  return errores.some((e) => {
    const codigo = (e as { extensions?: { exception?: { code?: unknown } } })?.extensions?.exception?.code
    return typeof codigo === 'string' && CODIGOS_AUTENTICACION.has(codigo)
  })
}

/**
 * Clasifica el error lanzado por `reportTransactionEvent`.
 *
 * Ambas clasificaciones responden 500 — la diferencia es el nivel y el texto
 * del log, es decir, si esto despierta a alguien o no. No existe aquí una
 * categoría "permanente": los fallos permanentes (importe inconsistente,
 * transacción inexistente) NO llegan como excepción, llegan como datos en el
 * campo `errors` de la mutación, y los resuelve el handler.
 *
 * El default deliberado es `TRANSITORIO`. Ante un error que no sabemos
 * clasificar preferimos que Wompi reintente (coste: ruido en el log; Saleor
 * deduplica el reintento igual) antes que dar por entregado un evento que
 * quizá nunca llegó (coste: un cobro real sin orden pagada).
 */
export function clasificarFalloSaleor(error: unknown): ClasificacionFalloSaleor {
  const status = statusHttpDe(error)

  // 401/403 explícitos del transporte: el token no sirve.
  if (status === 401 || status === 403) return 'AUTENTICACION'

  // Saleor devuelve HTTP 200 con un error GraphQL cuando el token es válido
  // pero le faltan permisos, o cuando la firma del JWT expiró.
  if (tieneCodigoDeAutenticacion(error)) return 'AUTENTICACION'

  return 'TRANSITORIO'
}
