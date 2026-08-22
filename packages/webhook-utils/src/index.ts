/**
 * Saleor Webhook Signature Verification
 *
 * HOW SALEOR SIGNS WEBHOOKS (app-registered via manifest):
 *
 * When a webhook is registered via the app manifest (no secretKey), Saleor signs
 * the request body using JWS (JSON Web Signature) with RS256 and its RSA private key.
 * The signature uses RFC 7797 (b64=false, detached payload):
 *   - Header:  BASE64URL({ alg: "RS256", kid: "...", crit: ["b64"], b64: false })
 *   - Payload: raw request body bytes (NOT base64url-encoded, NOT in the token)
 *   - Token format in `Saleor-Signature` header: "<header>..<signature>"
 *
 * Saleor's public keys are available at: {SALEOR_API_URL_BASE}/.well-known/jwks.json
 *
 * USAGE IN EVERY APP:
 *
 *   import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
 *
 *   const saleorApiUrl = process.env.SALEOR_API_URL!
 *
 *   app.post('/api/webhooks/my-event', async (request, reply) => {
 *     const signature = request.headers['saleor-signature'] as string
 *     const rawBody   = JSON.stringify(request.body)
 *
 *     try {
 *       await verifySaleorWebhook(rawBody, signature, saleorApiUrl)
 *     } catch (e) {
 *       return reply.status(401).send({ error: 'Invalid webhook signature' })
 *     }
 *
 *     // ... handle the verified event
 *   })
 *
 * SI SALEOR ROTA SU CLAVE RSA:
 *
 *   El proceso se recupera solo (`jose` recarga el JWKS; ver la nota de política
 *   de refresco en `verifySaleorWebhook`), pero puede tardar hasta 10 minutos —
 *   diez minutos rechazando webhooks legítimos de pago. Para forzarlo ya:
 *
 *     import { clearJwksCache } from '@licona/webhook-utils'
 *     clearJwksCache()
 *
 *   Cómo saber que es eso y no un atacante: el error trae `reason === 'unknown_key'`.
 *
 * DO NOT use HMAC / a shared secret for app-registered webhooks — Saleor does not
 * set a secretKey on webhooks created from the manifest. HMAC is only used for
 * manually created webhooks that explicitly have a secretKey.
 */

import { createRemoteJWKSet, flattenedVerify } from 'jose'

/**
 * Por qué falló la verificación. Es información **de diagnóstico**: ninguna de
 * estas ramas acepta la petición, todas rechazan. Sirve para responder una sola
 * pregunta operativa, a las 3 de la mañana y con los pagos caídos:
 *
 *   ¿esto es un problema mío (la clave rotó / no alcanzo el JWKS)
 *    o me están mandando firmas falsas?
 *
 * Deliberadamente corta. No es una taxonomía de errores criptográficos.
 *
 * - `missing_signature`   — no vino la cabecera. Casi siempre alguien probando el endpoint.
 * - `malformed_signature` — la cabecera no es un JWS compacto. Idem.
 * - `unknown_key`         — el JWS está bien formado pero **ninguna clave del JWKS en memoria
 *                           corresponde a su `kid`**. Esta es la firma de una ROTACIÓN de clave
 *                           en Saleor (o de estar apuntando a otra instancia de Saleor).
 *                           → acción del operador: `clearJwksCache()` y reintentar.
 * - `jwks_unavailable`    — no se pudo obtener el JWKS (timeout, DNS, 502, JSON inválido).
 *                           → acción del operador: mirar si Saleor está arriba y alcanzable.
 * - `invalid_signature`   — la clave SÍ estaba y aun así la firma no verifica, o el JWS es
 *                           inválido de otra forma. Esto es manipulación del cuerpo o una firma
 *                           forjada. → acción: mirar quién está llamando, no reiniciar nada.
 *
 * `invalid_signature` es el **valor por defecto**: cualquier error que no sepamos clasificar
 * cae en el cubo sospechoso, nunca en uno benigno.
 */
export type SaleorWebhookErrorReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'unknown_key'
  | 'jwks_unavailable'
  | 'invalid_signature'

export class SaleorWebhookError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    /**
     * Campo legible por máquina. El `message` ya distingue los casos en texto
     * (los call sites hacen `log.warn(e.message)` y se benefician sin tocarlos),
     * pero `reason` permite alertar/contar sin parsear strings — p. ej. disparar
     * una alerta solo ante `unknown_key`, que es el caso recuperable.
     */
    public readonly reason: SaleorWebhookErrorReason = 'invalid_signature',
  ) {
    super(message)
    this.name = 'SaleorWebhookError'
  }
}

/**
 * Códigos de error de `jose` (`JOSEError#code`). Se comparan por string y no con
 * `instanceof` a propósito: `instanceof` se rompe si hay dos copias de `jose` en
 * el árbol de node_modules (aquí conviven jose@4 y jose@5) o si el test mockea el
 * módulo. El código es estable y forma parte de la API pública de la librería.
 */
const CODIGOS_CLAVE_DESCONOCIDA = new Set([
  'ERR_JWKS_NO_MATCHING_KEY',
  // Varias claves compiten para el mismo `kid`/alg: el JWKS está en un estado raro,
  // típicamente a mitad de una rotación. Operativo, no ataque.
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
])

const CODIGOS_JWKS_INALCANZABLE = new Set([
  'ERR_JWKS_TIMEOUT',
  'ERR_JWKS_INVALID',
  // `jose` lanza un `JOSEError` genérico cuando el endpoint no responde 200 o el
  // cuerpo no es JSON parseable (ver runtime/fetch_jwks.js).
  'ERR_JOSE_GENERIC',
])

/**
 * ¿Es un error de transporte de Node (ECONNREFUSED, ENOTFOUND, ETIMEDOUT…)?
 *
 * Se mira `syscall`, no `code`: los `SystemError` de Node siempre traen la
 * llamada al sistema que falló (`connect`, `getaddrinfo`, `read`), y esa
 * propiedad no la tiene ningún error de `jose` ni un `TypeError` normal.
 * Enumerar los `code` posibles sería una lista incompleta desde el día uno.
 */
function esErrorDeTransporte(err: unknown): boolean {
  return typeof (err as { syscall?: unknown } | null)?.syscall === 'string'
}

function clasificarError(err: unknown): SaleorWebhookErrorReason {
  const codigo = (err as { code?: unknown } | null)?.code

  if (typeof codigo === 'string') {
    if (CODIGOS_CLAVE_DESCONOCIDA.has(codigo)) return 'unknown_key'
    if (CODIGOS_JWKS_INALCANZABLE.has(codigo)) return 'jwks_unavailable'
  }

  if (esErrorDeTransporte(err)) return 'jwks_unavailable'

  // Por defecto, el cubo sospechoso. Aquí caen
  // ERR_JWS_SIGNATURE_VERIFICATION_FAILED, ERR_JWS_INVALID,
  // ERR_JOSE_ALG_NOT_ALLOWED, y también cualquier error que no reconozcamos
  // (p. ej. el `TypeError` que lanza `checkKeyTypeWithJwk` si el `alg` de la
  // cabecera no cuadra con el tipo de la clave del JWKS — un JWS que dice
  // `HS256` para que se le verifique con una clave RSA).
  //
  // Es a propósito: preferimos etiquetar de sospechoso algo operativo a
  // etiquetar de operativo algo que es un ataque. Un `unknown_key` mal puesto
  // le diría al operador "tranquilo, reinicia el cache" mientras le están
  // forjando firmas.
  return 'invalid_signature'
}

/**
 * Un resolver de claves de `jose` por URL de JWKS.
 *
 * OJO — lo que se cachea aquí NO son las claves, es el *resolver*. `jose` gestiona
 * las claves por dentro con sus propias políticas (ver `verifySaleorWebhook`).
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJWKS(saleorApiUrl: string) {
  const baseUrl = saleorApiUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '')
  const jwksUrl = `${baseUrl}/.well-known/jwks.json`

  if (!jwksCache.has(jwksUrl)) {
    jwksCache.set(jwksUrl, createRemoteJWKSet(new URL(jwksUrl)))
  }
  return jwksCache.get(jwksUrl)!
}

/**
 * Descarta los resolvers de JWKS cacheados. El siguiente webhook construye uno
 * nuevo y vuelve a descargar `/.well-known/jwks.json` de inmediato.
 *
 * Devuelve cuántas entradas se descartaron, para que el operador vea en el log
 * que la llamada hizo algo (`0` = no había nada cacheado todavía).
 *
 * ── POR QUÉ ESTA FORMA Y NO INYECTAR EL RESOLVER ─────────────────────────────
 * La alternativa considerada era pasar el resolver como parámetro opcional de
 * `verifySaleorWebhook`. Resuelve muy bien la testabilidad, pero **no resuelve el
 * problema operativo**, que es el que importa: quien necesita esto es un operador
 * con la instancia de un cliente rechazando pagos, no un test. Inyectar obliga a
 * que *cada app* construya y guarde su propio resolver, con lo que la política de
 * caché deja de vivir en el paquete compartido y pasa a estar replicada (y a
 * divergir) en wompi, envios y las que vengan. La ruta por defecto —la que corren
 * las 7 llamadas reales de hoy— seguiría sin tener ningún asidero para refrescar.
 * `clearJwksCache()` es un único punto de invalidación para todo el proceso, es
 * lo que se puede colgar de un endpoint de admin o de un handler de SIGHUP, y de
 * paso también quita el `vi.resetModules()` de los tests.
 *
 * ⚠️ NO LLAMAR AUTOMÁTICAMENTE DESDE LA RUTA DE FALLO. Invalidar en cada
 * verificación fallida convertiría el endpoint en un amplificador: cualquiera
 * mandando firmas basura forzaría una descarga del JWKS por petición contra
 * Saleor, saltándose el cooldown que `jose` tiene justamente para evitar eso.
 * Esto es una palanca manual (o, como mucho, atada a un evento administrativo
 * autenticado). Nunca refleja del tráfico entrante.
 */
export function clearJwksCache(): number {
  const descartados = jwksCache.size
  jwksCache.clear()
  return descartados
}

/**
 * Verify the `Saleor-Signature` header on an incoming webhook request.
 *
 * @param rawBody      - Raw request body string (JSON.stringify(request.body))
 * @param signature    - Value of the `Saleor-Signature` header
 * @param saleorApiUrl - Full Saleor GraphQL URL, e.g. "https://api.example.com/graphql/"
 *
 * @throws SaleorWebhookError if the signature is missing, malformed, or invalid.
 *         Ver `SaleorWebhookErrorReason` para distinguir el motivo.
 *
 * ── POLÍTICA DE REFRESCO DEL JWKS: LA PONE `jose`, NO NOSOTROS ───────────────
 *
 * Antes de añadir aquí un TTL propio o un "reintenta una vez por si la clave
 * rotó", se leyó qué hace `createRemoteJWKSet` por su cuenta
 * (`jose@5.10.0`, `dist/node/esm/jwks/remote.js`, clase `RemoteJWKSet`).
 * Resumen de lo que YA hace, con sus valores por defecto:
 *
 *   1. TTL. `cacheMaxAge = 600_000 ms` (10 min). En cada `getKey()`, si el JWKS
 *      en memoria no está `fresh()`, lo vuelve a descargar antes de resolver.
 *      → Ya existe un TTL. Añadir otro por encima solo desincronizaría los dos.
 *
 *   2. Reintento único ante clave desconocida. Si el JWKS local lanza
 *      `JWKSNoMatchingKey`, y no está en cooldown, hace `reload()` y **reintenta
 *      la resolución una sola vez**. Es exactamente el "refrescar y reintentar"
 *      que se planteaba implementar aquí.
 *
 *   3. Cooldown. `cooldownDuration = 30_000 ms` (30 s) limita ese reintento. Es
 *      una protección deliberada: sin él, mandar JWS con `kid` aleatorios sería
 *      un ataque de amplificación gratuito contra `/.well-known/jwks.json`.
 *
 *   4. Coalescing. `_pendingFetch` hace que N peticiones concurrentes compartan
 *      una sola descarga, en vez de una tormenta de fetches.
 *
 * CONCLUSIÓN: no se añade TTL ni reintento propios. Duplicarlos sería peor que
 * no hacer nada — haría 2 descargas donde va 1, y un reintento nuestro por
 * encima del suyo anularía el cooldown, que es justo la pieza de seguridad.
 *
 * Corolario importante para el diagnóstico: ante una rotación de clave el
 * proceso **se recupera solo**, en el peor caso en `cacheMaxAge` (10 min), e
 * inmediatamente si el `kid` nuevo dispara la rama (2). Lo que faltaba no era
 * caducidad, era (a) poder forzar el refresco YA en vez de esperar 10 minutos de
 * pagos rechazados → `clearJwksCache()`, y (b) poder ver en el log que la causa
 * es la clave y no un atacante → `SaleorWebhookErrorReason`.
 *
 * Nota sobre el reintento de (2): `jose` lo hace SOLO ante `JWKSNoMatchingKey`,
 * nunca ante una firma que no verifica con una clave que sí estaba. Eso es lo
 * correcto y no debe cambiarse: una firma forjada bajo un `kid` conocido jamás
 * debe provocar una recarga ni un segundo intento.
 */
export async function verifySaleorWebhook(
  rawBody: string,
  signature: string | undefined,
  saleorApiUrl: string,
): Promise<void> {
  if (!signature) {
    throw new SaleorWebhookError(
      'Missing Saleor-Signature header',
      undefined,
      'missing_signature',
    )
  }

  // Compact JWS with detached payload: "<header>..<sig>" (two dots, empty middle)
  const parts = signature.split('.')
  if (parts.length !== 3) {
    throw new SaleorWebhookError(
      'Malformed Saleor-Signature: expected compact JWS',
      undefined,
      'malformed_signature',
    )
  }
  const [protectedHeader, , sig] = parts

  try {
    await flattenedVerify(
      {
        protected: protectedHeader,
        payload: Buffer.from(rawBody),
        signature: sig,
      },
      getJWKS(saleorApiUrl),
    )
  } catch (err) {
    // Clasificar NO cambia la decisión: aquí ya se rechaza, pase lo que pase.
    // Lo único que cambia es qué lee el operador en el log.
    const reason = clasificarError(err)
    throw new SaleorWebhookError(MENSAJE_POR_MOTIVO[reason], err, reason)
  }
}

/**
 * El mensaje se escribe para el humano que lo va a leer en el log a las 3 a. m.:
 * dice qué pasó y qué hacer. Los call sites ya hacen `log.warn(e.message)`, así
 * que mejoran sin tocarlos.
 *
 * `invalid_signature` conserva el texto histórico a propósito: es el mensaje que
 * ya salía en producción y sobre el que puede haber alertas o greps montados.
 */
const MENSAJE_POR_MOTIVO: Record<SaleorWebhookErrorReason, string> = {
  missing_signature: 'Missing Saleor-Signature header',
  malformed_signature: 'Malformed Saleor-Signature: expected compact JWS',
  unknown_key:
    'Webhook rejected: signing key not found in Saleor JWKS. Saleor likely rotated ' +
    'its RSA key; the cached key set is stale. This is NOT a forged signature. ' +
    'Call clearJwksCache() to refetch immediately, or wait for jose to refresh it.',
  jwks_unavailable:
    'Webhook rejected: could not fetch Saleor JWKS (/.well-known/jwks.json). ' +
    'This is a connectivity or Saleor availability problem, NOT a forged signature.',
  invalid_signature: 'Webhook signature verification failed',
}
