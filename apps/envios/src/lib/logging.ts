import { randomUUID } from 'node:crypto'

/**
 * Configuración del logger de la App de envíos.
 *
 * Gemela de `apps/wompi/src/lib/logging.ts` — mismas decisiones, mismo formato
 * de salida. Se mantiene una copia por App y no un módulo compartido a
 * propósito: `@licona/webhook-utils` es la verificación de firmas de webhooks y
 * no depende de Fastify, y meterle configuración de logging le cambiaría el
 * propósito. La lista de rutas sí diverge donde tiene que divergir: aquí no hay
 * `acceptance_token` porque aquí no hay Wompi.
 *
 * Si se toca una, revisar la otra.
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
 * El caso que lo motiva es real y estaba en este repo: `/api/register` escribía
 * `{ token: auth_token }` — el token de la App de Saleor entero — en el log.
 * El handler ya no lo hace (ver `lib/registro.ts`), pero `redact` es la red que
 * no depende de que el próximo `log.info` se acuerde.
 *
 * El comodín `*` cubre UN nivel de anidamiento; pino no tiene comodín de
 * profundidad arbitraria. No se listan rutas bajo `req.*`: Fastify serializa
 * `req` antes de redactar y su serializer por defecto ya descarta las cabeceras.
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
  '*.token',
  '*.auth_token',
  '*.authToken',
  '*.secret',
  '*.password',
  '*.privateKey',
  '*.private_key',
] as const

/**
 * Nivel de log resuelto desde el entorno. Un valor inválido NO tumba el
 * proceso: se cae al default y se avisa (`avisoNivelLogInvalido`).
 */
export function nivelLog(env: NodeJS.ProcessEnv = process.env): string {
  const nivel = env.LOG_LEVEL?.trim().toLowerCase()
  if (!nivel) return NIVEL_POR_DEFECTO
  return (NIVELES_VALIDOS as readonly string[]).includes(nivel) ? nivel : NIVEL_POR_DEFECTO
}

/** Aviso de arranque cuando `LOG_LEVEL` trae algo que pino no entiende. */
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
