import { randomUUID } from 'node:crypto'

/**
 * Configuración del logger.
 *
 * El logger de esta App es el que Fastify trae embebido (pino por dentro), que
 * hasta ahora se activaba a pelo con `Fastify({ logger: true })`: sin nivel,
 * sin `redact` y sin serializers. Esto NO añade ninguna librería — solo pone
 * configuración donde antes había un `true`.
 *
 * Lo que se fija aquí, y por qué:
 *
 *  1. **`redact`** — el logger escribe el objeto que se le pasa TAL CUAL. Los
 *     handlers ya loguean contextos con el payload crudo (`rawBody`) y con
 *     errores enteros. Una credencial en un log retenido sigue siendo una
 *     credencial válida a la vista de cualquiera con acceso de lectura al panel
 *     de despliegue. `redact` es la red que no depende de que cada `log.error`
 *     futuro se acuerde de excluirla.
 *
 *  2. **Nivel por entorno** — `LOG_LEVEL`, default `info`. En una App de pagos
 *     el camino feliz también es evidencia (hace falta para reconstruir una
 *     cadena, no solo para explicar un fallo), así que el default NO es `warn`.
 *
 *  3. **`genReqId`** — identificador del salto LOCAL, complementario a las
 *     claves de dominio (`checkoutId`, `transactionId`, `pspReference`), no un
 *     sustituto: sirve para juntar todas las líneas de UNA petición de esta
 *     App. Se genera aquí y NO se acepta del exterior (Fastify 5 trae
 *     `requestIdHeader` desactivado por defecto y así se deja): un id que
 *     controla el llamante puede colisionar a propósito y deja de identificar
 *     nada. La correlación ENTRE servicios la hacen las claves de dominio, que
 *     son verificables contra Saleor.
 */

/** Valor que sustituye a una credencial en el log. */
export const CENSURA = '[REDACTADO]'

/** Nivel usado cuando `LOG_LEVEL` no está o no es válido. */
export const NIVEL_POR_DEFECTO = 'info'

/** Niveles que pino acepta. Uno fuera de esta lista hace que pino LANCE al construirse. */
export const NIVELES_VALIDOS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/**
 * Rutas que se censuran en todo objeto logueado.
 *
 * Dos familias:
 *  - por **cabecera** (`authorization`, `saleor-signature`), para cuando se
 *    loguea un objeto de cabeceras a mano;
 *  - por **nombre de campo** (`token`, `secret`, …), que es como se han colado
 *    hasta ahora: un `log.info({ token })` bienintencionado.
 *
 * El comodín `*` cubre UN nivel de anidamiento, que es donde caen los casos
 * reales (`{ contexto: { token } }`, `{ peticion: { headers: { authorization } } }`).
 * pino no tiene comodín de profundidad arbitraria, así que esto **acota** el
 * riesgo, no lo elimina: la regla sigue siendo no meter credenciales en el
 * contexto, y `redact` es la red por debajo.
 *
 * No se listan rutas bajo `req.*`: Fastify serializa `req` ANTES de redactar y
 * su serializer por defecto ya descarta las cabeceras enteras (solo emite
 * method/url/host/remoteAddress). Una ruta ahí sería configuración muerta que
 * aparenta protección.
 */
export const RUTAS_REDACTADAS = [
  // Cabeceras.
  'authorization',
  'headers.authorization',
  'headers["saleor-signature"]',
  '*.authorization',
  '*.headers.authorization',
  '*.headers["saleor-signature"]',
  // Credenciales por nombre de campo.
  'token',
  'auth_token',
  'authToken',
  'secret',
  'password',
  'privateKey',
  'private_key',
  // Específica de Wompi: el acceptance_token del merchant.
  'acceptanceToken',
  'acceptance_token',
  '*.token',
  '*.auth_token',
  '*.authToken',
  '*.secret',
  '*.password',
  '*.privateKey',
  '*.private_key',
  '*.acceptanceToken',
  '*.acceptance_token',
] as const

/**
 * Nivel de log resuelto desde el entorno.
 *
 * Un `LOG_LEVEL` inválido NO tumba el proceso: pino lanzaría al construirse, y
 * una App de pagos caída por una errata en la verbosidad del log es peor fallo
 * que la errata. Se cae al default y se avisa (ver `avisoNivelLogInvalido`).
 */
export function nivelLog(env: NodeJS.ProcessEnv = process.env): string {
  const nivel = env.LOG_LEVEL?.trim().toLowerCase()
  if (!nivel) return NIVEL_POR_DEFECTO
  return (NIVELES_VALIDOS as readonly string[]).includes(nivel) ? nivel : NIVEL_POR_DEFECTO
}

/**
 * Aviso de arranque cuando `LOG_LEVEL` trae algo que pino no entiende.
 * Devuelve `null` si no hay nada que avisar. Mismo patrón que
 * `mensajeModoDegradado()`: función pura, y quien la llama decide cómo
 * escribirla — el logger todavía no existe cuando se calcula.
 */
export function avisoNivelLogInvalido(env: NodeJS.ProcessEnv = process.env): string | null {
  const nivel = env.LOG_LEVEL?.trim().toLowerCase()
  if (!nivel || (NIVELES_VALIDOS as readonly string[]).includes(nivel)) return null
  return (
    `LOG_LEVEL="${env.LOG_LEVEL}" no es un nivel válido (${NIVELES_VALIDOS.join(', ')}). ` +
    `Se usa "${NIVEL_POR_DEFECTO}"`
  )
}

/** Opciones del logger embebido de Fastify. */
export function opcionesLogger(env: NodeJS.ProcessEnv = process.env) {
  return {
    level: nivelLog(env),
    redact: { paths: [...RUTAS_REDACTADAS], censor: CENSURA },
  }
}

/** Opciones de servidor relacionadas con observabilidad. */
export function opcionesServidor(env: NodeJS.ProcessEnv = process.env) {
  return {
    logger: opcionesLogger(env),
    genReqId: () => randomUUID(),
  }
}
