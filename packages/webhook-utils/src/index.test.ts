/**
 * Tests de `verifySaleorWebhook` — la puerta de entrada de todos los webhooks
 * que Saleor manda a las Apps de pago. Si esta función acepta una firma que no
 * debería, cualquiera puede inyectar eventos de transacción falsos.
 *
 * Estrategia:
 *   - Criptografía REAL: se generan pares RSA de verdad con `jose` y se firma
 *     con `FlattenedSign` usando el mismo esquema que Saleor
 *     (RFC 7797: `b64=false`, `crit: ['b64']`, payload separado).
 *   - Red CERO: se mockea únicamente `createRemoteJWKSet` para que devuelva la
 *     clave pública local en vez de ir a `/.well-known/jwks.json`. El resto de
 *     `jose` (incluido `flattenedVerify`, que es lo que queremos probar) es el
 *     módulo real.
 *
 * El doble de `createRemoteJWKSet` imita dos comportamientos del real que son
 * imprescindibles para poder probar la rotación de claves:
 *
 *   1. RESUELVE POR `kid`, como hace `createLocalJWKSet` de verdad. Si ninguna
 *      clave del conjunto tiene ese `kid`, lanza el `JWKSNoMatchingKey` REAL de
 *      `jose` — el mismo error, con el mismo `code`, que clasifica el módulo.
 *   2. FOTOGRAFÍA las claves en el momento de CONSTRUIRSE, no en el de llamarse.
 *      Un resolver ya construido conserva el JWKS que descargó; eso es
 *      exactamente lo que hace que una rotación de clave rompa las cosas, y sin
 *      esa fotografía el test de rotación no probaría nada.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlattenedSign, generateKeyPair, type KeyLike } from 'jose'
import {
  clearJwksCache,
  SaleorWebhookError,
  verifySaleorWebhook,
  type SaleorWebhookErrorReason,
} from './index.js'

/**
 * Contenedor mutable con el JWKS "remoto" simulado. Va en `vi.hoisted` porque la
 * factory de `vi.mock` se iza por encima de los imports y no puede cerrar sobre
 * variables normales del módulo.
 */
const jwksSimulado = vi.hoisted(() => ({
  claves: [] as Array<{ kid: string; clave: unknown }>,
  /** Si se fija, el resolver lanza esto en vez de resolver (simula fallo de red). */
  errorAlResolver: null as unknown,
}))

vi.mock('jose', async (importOriginal) => {
  const real = await importOriginal<typeof import('jose')>()
  return {
    ...real,
    // Sustituye SOLO la obtención remota de claves. `flattenedVerify` sigue
    // siendo el real: la verificación criptográfica no está falseada.
    createRemoteJWKSet: vi.fn(() => {
      // Fotografía en el momento de construir — ver punto (2) de la cabecera.
      const instantanea = [...jwksSimulado.claves]
      const errorFijado = jwksSimulado.errorAlResolver

      return async (protectedHeader: { kid?: string }) => {
        if (errorFijado) throw errorFijado
        const encontrada = instantanea.find((k) => k.kid === protectedHeader.kid)
        if (!encontrada) throw new real.errors.JWKSNoMatchingKey()
        return encontrada.clave
      }
    }),
  }
})

const SALEOR_API_URL = 'https://api.tienda-ejemplo.co/graphql/'

/** `kid` de la clave con la que Saleor firma "hoy". */
const KID_VIGENTE = 'saleor-key-2026-08'
/** `kid` de la clave tras una rotación. */
const KID_ROTADO = 'saleor-key-2026-09'

/** Cuerpo típico de un webhook de transacción (montos en COP, sin decimales). */
const CUERPO = JSON.stringify({
  transaction: { id: 'VHJhbnNhY3Rpb246MQ==' },
  action: { amount: 120000, currency: 'COP', actionType: 'CHARGE' },
})

let parLegitimo: { publicKey: KeyLike; privateKey: KeyLike }
let parAtacante: { publicKey: KeyLike; privateKey: KeyLike }
let parRotado: { publicKey: KeyLike; privateKey: KeyLike }

/**
 * Firma `cuerpo` igual que lo hace Saleor y devuelve el valor de la cabecera
 * `Saleor-Signature`: JWS compacto con payload separado, "<header>..<sig>".
 *
 * El `kid` por defecto es el vigente: así, firmar con la clave del atacante
 * modela el caso realista —reutiliza el `kid` legítimo para que el resolver sí
 * encuentre una clave— y no se confunde con una rotación.
 */
async function firmarComoSaleor(
  cuerpo: string,
  clavePrivada: KeyLike,
  kid: string = KID_VIGENTE,
): Promise<string> {
  const jws = await new FlattenedSign(new TextEncoder().encode(cuerpo))
    .setProtectedHeader({ alg: 'RS256', b64: false, crit: ['b64'], kid })
    .sign(clavePrivada)

  if (!jws.protected) throw new Error('jose no devolvió el header protegido')
  return `${jws.protected}..${jws.signature}`
}

/** Ejecuta la verificación y devuelve el error lanzado (o `undefined` si pasó). */
async function capturarError(
  cuerpo: string,
  firma: string | undefined,
): Promise<unknown> {
  return verifySaleorWebhook(cuerpo, firma, SALEOR_API_URL).then(
    () => undefined,
    (err: unknown) => err,
  )
}

/** Atajo: el `reason` del error, o `undefined` si no hubo error. */
async function motivoDelRechazo(
  cuerpo: string,
  firma: string | undefined,
): Promise<SaleorWebhookErrorReason | undefined> {
  const error = await capturarError(cuerpo, firma)
  expect(error).toBeInstanceOf(SaleorWebhookError)
  return (error as SaleorWebhookError).reason
}

beforeAll(async () => {
  // Generar RSA es caro (~100 ms); se hace una sola vez para toda la suite.
  parLegitimo = await generateKeyPair('RS256')
  parAtacante = await generateKeyPair('RS256')
  parRotado = await generateKeyPair('RS256')
})

beforeEach(() => {
  // Ya NO hace falta `vi.resetModules()` + reimportar el módulo. Antes era la
  // única forma de tirar el `jwksCache` interno, porque no había ninguna vía
  // para vaciarlo; ahora `clearJwksCache()` es esa vía y el módulo se importa
  // estáticamente una sola vez, como cualquier otro. Que el aislamiento entre
  // tests salga gratis de la API pública, en vez de exigir un truco del test
  // runner, es precisamente la señal de que la API que faltaba ya está.
  vi.clearAllMocks()
  clearJwksCache()
  jwksSimulado.claves = [{ kid: KID_VIGENTE, clave: parLegitimo.publicKey }]
  jwksSimulado.errorAlResolver = null
})

describe('verifySaleorWebhook', () => {
  it('acepta una firma válida generada sobre el rawBody exacto', async () => {
    const firma = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)

    await expect(
      verifySaleorWebhook(CUERPO, firma, SALEOR_API_URL),
    ).resolves.toBeUndefined()
  })

  it('rechaza cuando falta la cabecera Saleor-Signature', async () => {
    const error = await capturarError(CUERPO, undefined)

    expect(error).toBeInstanceOf(SaleorWebhookError)
    expect((error as Error).message).toBe('Missing Saleor-Signature header')
  })

  it('rechaza una cabecera vacía', async () => {
    const error = await capturarError(CUERPO, '')

    expect(error).toBeInstanceOf(SaleorWebhookError)
    expect((error as Error).message).toBe('Missing Saleor-Signature header')
  })

  it.each([
    ['sin puntos', 'esto-no-es-un-jws'],
    ['un solo punto', 'header.firma'],
    ['cuatro partes', 'header..firma.extra'],
  ])('rechaza una firma malformada (%s)', async (_caso, firmaMalformada) => {
    const error = await capturarError(CUERPO, firmaMalformada)

    expect(error).toBeInstanceOf(SaleorWebhookError)
    expect((error as Error).message).toBe(
      'Malformed Saleor-Signature: expected compact JWS',
    )
  })

  // ── El test que importa: detectar manipulación del payload ────────────────
  it('rechaza un cuerpo alterado aunque la firma sea de la clave legítima', async () => {
    // El atacante intercepta un webhook legítimo de $120.000 y le cambia el
    // monto, reenviando la firma original intacta.
    const cuerpoOriginal = JSON.stringify({ action: { amount: 120000 } })
    const cuerpoAlterado = JSON.stringify({ action: { amount: 999999 } })
    const firma = await firmarComoSaleor(cuerpoOriginal, parLegitimo.privateKey)

    const error = await capturarError(cuerpoAlterado, firma)

    expect(error).toBeInstanceOf(SaleorWebhookError)
  })

  it('rechaza un cuerpo que difiere en un solo byte', async () => {
    const cuerpoOriginal = JSON.stringify({ action: { amount: 120000 } })
    const cuerpoAlterado = JSON.stringify({ action: { amount: 120001 } })
    expect(cuerpoAlterado.length).toBe(cuerpoOriginal.length) // difiere 1 byte
    const firma = await firmarComoSaleor(cuerpoOriginal, parLegitimo.privateKey)

    const error = await capturarError(cuerpoAlterado, firma)

    expect(error).toBeInstanceOf(SaleorWebhookError)
  })

  it('rechaza un JWS bien formado firmado con otro par RSA', async () => {
    // Firma emitida por una clave que NO está en el JWKS de Saleor, pero que
    // reutiliza el `kid` legítimo para que el resolver sí devuelva una clave.
    const firma = await firmarComoSaleor(CUERPO, parAtacante.privateKey)

    const error = await capturarError(CUERPO, firma)

    expect(error).toBeInstanceOf(SaleorWebhookError)
  })

  it('envuelve el error de jose en SaleorWebhookError en vez de propagarlo crudo', async () => {
    const firma = await firmarComoSaleor(CUERPO, parAtacante.privateKey)

    const error = await capturarError(CUERPO, firma)

    expect(error).toBeInstanceOf(SaleorWebhookError)
    expect((error as Error).name).toBe('SaleorWebhookError')
    expect((error as Error).message).toBe('Webhook signature verification failed')
    // La causa original de jose se conserva para diagnóstico, pero no escapa
    // como error suelto hacia el handler HTTP.
    const causa = (error as SaleorWebhookError).cause
    expect(causa).toBeInstanceOf(Error)
    expect(causa).not.toBeInstanceOf(SaleorWebhookError)
  })

  it('cachea el JWKS por URL y no lo vuelve a construir en cada request', async () => {
    const { createRemoteJWKSet } = await import('jose')
    const firma = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)

    await verifySaleorWebhook(CUERPO, firma, SALEOR_API_URL)
    await verifySaleorWebhook(CUERPO, firma, SALEOR_API_URL)

    expect(vi.mocked(createRemoteJWKSet)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createRemoteJWKSet).mock.calls[0]![0]!.toString()).toBe(
      'https://api.tienda-ejemplo.co/.well-known/jwks.json',
    )
  })
})

// ── Invalidación del cache de JWKS ──────────────────────────────────────────
describe('clearJwksCache', () => {
  it('fuerza a reconstruir el resolver en la siguiente verificación', async () => {
    const { createRemoteJWKSet } = await import('jose')
    const firma = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)

    await verifySaleorWebhook(CUERPO, firma, SALEOR_API_URL)
    expect(vi.mocked(createRemoteJWKSet)).toHaveBeenCalledTimes(1)

    clearJwksCache()

    await verifySaleorWebhook(CUERPO, firma, SALEOR_API_URL)
    // Se construyó uno NUEVO: no se reusó el viejo.
    expect(vi.mocked(createRemoteJWKSet)).toHaveBeenCalledTimes(2)
  })

  it('informa cuántas entradas descartó, para que el operador lo vea en el log', async () => {
    const firma = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)

    // Nada cacheado todavía: el operador ve un 0 y sabe que no hizo nada.
    expect(clearJwksCache()).toBe(0)

    await verifySaleorWebhook(CUERPO, firma, SALEOR_API_URL)

    expect(clearJwksCache()).toBe(1)
    expect(clearJwksCache()).toBe(0)
  })

  // ── El escenario que motiva todo esto ─────────────────────────────────────
  it('recupera el servicio tras una rotación de clave en Saleor', async () => {
    // 1. Estado normal: la App verifica bien y se queda con el JWKS en memoria.
    const firmaVieja = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)
    await expect(
      verifySaleorWebhook(CUERPO, firmaVieja, SALEOR_API_URL),
    ).resolves.toBeUndefined()

    // 2. Saleor rota su clave RSA y empieza a firmar con otra, bajo un kid nuevo.
    //    El JWKS remoto ya solo publica la nueva.
    jwksSimulado.claves = [{ kid: KID_ROTADO, clave: parRotado.publicKey }]
    const firmaNueva = await firmarComoSaleor(
      CUERPO,
      parRotado.privateKey,
      KID_ROTADO,
    )

    // 3. Con el resolver viejo en cache, el webhook LEGÍTIMO se rechaza. Esta es
    //    la caída de pagos: desde fuera parece un ataque y no lo es.
    const motivoConCacheViejo = await motivoDelRechazo(CUERPO, firmaNueva)
    expect(motivoConCacheViejo).toBe('unknown_key')

    // 4. El operador invalida el cache.
    expect(clearJwksCache()).toBe(1)

    // 5. La firma de la clave NUEVA se acepta, sin reiniciar el proceso.
    await expect(
      verifySaleorWebhook(CUERPO, firmaNueva, SALEOR_API_URL),
    ).resolves.toBeUndefined()
  })

  it('NO debilita la verificación: una firma forjada sigue rechazándose tras invalidar', async () => {
    // Misma rotación que arriba, pero el que llama es un atacante que reutiliza
    // el kid nuevo y firma con su propia clave.
    jwksSimulado.claves = [{ kid: KID_ROTADO, clave: parRotado.publicKey }]
    clearJwksCache()

    const firmaForjada = await firmarComoSaleor(
      CUERPO,
      parAtacante.privateKey,
      KID_ROTADO,
    )

    expect(await motivoDelRechazo(CUERPO, firmaForjada)).toBe('invalid_signature')

    // Invalidar otra vez tampoco la deja pasar: refrescar claves no es aflojar.
    clearJwksCache()
    expect(await motivoDelRechazo(CUERPO, firmaForjada)).toBe('invalid_signature')

    // Y un cuerpo manipulado con firma de la clave vigente tampoco.
    clearJwksCache()
    const firmaSobreOtroCuerpo = await firmarComoSaleor(
      JSON.stringify({ action: { amount: 1 } }),
      parRotado.privateKey,
      KID_ROTADO,
    )
    expect(await motivoDelRechazo(CUERPO, firmaSobreOtroCuerpo)).toBe(
      'invalid_signature',
    )
  })
})

// ── Diagnóstico: ¿es la clave o es un atacante? ─────────────────────────────
describe('SaleorWebhookError.reason', () => {
  it('distingue una clave rotada de una firma manipulada', async () => {
    // Caso A — clave desconocida: Saleor firmó con un kid que no está en el JWKS.
    const firmaDeClaveRotada = await firmarComoSaleor(
      CUERPO,
      parRotado.privateKey,
      KID_ROTADO,
    )
    const errorRotacion = (await capturarError(
      CUERPO,
      firmaDeClaveRotada,
    )) as SaleorWebhookError

    // Caso B — firma forjada: el kid SÍ está, la firma no cuadra con esa clave.
    clearJwksCache()
    const firmaForjada = await firmarComoSaleor(CUERPO, parAtacante.privateKey)
    const errorForjado = (await capturarError(
      CUERPO,
      firmaForjada,
    )) as SaleorWebhookError

    // Los dos rechazan — eso no cambia.
    expect(errorRotacion).toBeInstanceOf(SaleorWebhookError)
    expect(errorForjado).toBeInstanceOf(SaleorWebhookError)

    // Pero ya no son indistinguibles, ni por `reason` ni por lo que se loguea.
    expect(errorRotacion.reason).toBe('unknown_key')
    expect(errorForjado.reason).toBe('invalid_signature')
    expect(errorRotacion.message).not.toBe(errorForjado.message)

    // El mensaje de rotación tiene que decirle al operador qué hacer, porque los
    // call sites lo único que loguean es `err.message`.
    expect(errorRotacion.message).toContain('rotated')
    expect(errorRotacion.message).toContain('clearJwksCache()')
  })

  it('marca como jwks_unavailable un fallo de red al bajar el JWKS', async () => {
    // Saleor caído / DNS roto: `jose` propaga el error de transporte de Node,
    // que no lleva ningún `code` de jose.
    // Forma real de un SystemError de Node: trae `syscall` además de `code`.
    const errorDeRed = Object.assign(
      new Error('connect ECONNREFUSED 10.0.0.5:443'),
      { code: 'ECONNREFUSED', errno: -61, syscall: 'connect' },
    )
    jwksSimulado.errorAlResolver = errorDeRed
    clearJwksCache()

    const firma = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)
    const error = (await capturarError(CUERPO, firma)) as SaleorWebhookError

    expect(error.reason).toBe('jwks_unavailable')
    expect(error.message).toContain('NOT a forged signature')
    expect(error.cause).toBe(errorDeRed)
  })

  it('marca como jwks_unavailable un timeout contra /.well-known/jwks.json', async () => {
    const { errors } = await vi.importActual<typeof import('jose')>('jose')
    jwksSimulado.errorAlResolver = new errors.JWKSTimeout()
    clearJwksCache()

    const firma = await firmarComoSaleor(CUERPO, parLegitimo.privateKey)
    const error = (await capturarError(CUERPO, firma)) as SaleorWebhookError

    expect(error.reason).toBe('jwks_unavailable')
  })

  it.each([
    ['falta la cabecera', undefined, 'missing_signature'],
    ['la cabecera no es un JWS', 'no-es-un-jws', 'malformed_signature'],
  ])('clasifica %s como %s', async (_caso, firma, motivoEsperado) => {
    expect(await motivoDelRechazo(CUERPO, firma as string | undefined)).toBe(
      motivoEsperado,
    )
  })

  it('cae en invalid_signature ante un error inesperado, no en un motivo benigno', async () => {
    // Regla dura: lo que no se sabe clasificar como problema propio se trata
    // como sospechoso. Un JWS con un `alg` que jose no soporta llega aquí.
    const firmaConAlgRaro = `${Buffer.from(
      JSON.stringify({ alg: 'HS256', b64: false, crit: ['b64'], kid: KID_VIGENTE }),
    ).toString('base64url')}..firma`

    expect(await motivoDelRechazo(CUERPO, firmaConAlgRaro)).toBe('invalid_signature')
  })
})
