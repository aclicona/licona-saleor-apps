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
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlattenedSign, generateKeyPair, type KeyLike } from 'jose'

/**
 * Contenedor mutable con la clave pública que el JWKS "remoto" simulado
 * devolverá. Va en `vi.hoisted` porque la factory de `vi.mock` se iza por
 * encima de los imports y no puede cerrar sobre variables normales del módulo.
 */
const jwksSimulado = vi.hoisted(() => ({ clavePublica: null as unknown }))

vi.mock('jose', async (importOriginal) => {
  const real = await importOriginal<typeof import('jose')>()
  return {
    ...real,
    // Sustituye SOLO la obtención remota de claves. `flattenedVerify` sigue
    // siendo el real: la verificación criptográfica no está falseada.
    createRemoteJWKSet: vi.fn(() => async () => jwksSimulado.clavePublica),
  }
})

type ModuloBajoPrueba = typeof import('./index.js')

// El módulo cachea el JWKS en un `Map` a nivel de módulo (`jwksCache`), así que
// se reimporta en cada test tras `vi.resetModules()` para que ese estado no se
// filtre entre casos (p. ej. que el test de "otra clave" reutilice el resolver
// del test anterior).
let verifySaleorWebhook: ModuloBajoPrueba['verifySaleorWebhook']
let SaleorWebhookError: ModuloBajoPrueba['SaleorWebhookError']

const SALEOR_API_URL = 'https://api.tienda-ejemplo.co/graphql/'

/** Cuerpo típico de un webhook de transacción (montos en COP, sin decimales). */
const CUERPO = JSON.stringify({
  transaction: { id: 'VHJhbnNhY3Rpb246MQ==' },
  action: { amount: 120000, currency: 'COP', actionType: 'CHARGE' },
})

let parLegitimo: { publicKey: KeyLike; privateKey: KeyLike }
let parAtacante: { publicKey: KeyLike; privateKey: KeyLike }

/**
 * Firma `cuerpo` igual que lo hace Saleor y devuelve el valor de la cabecera
 * `Saleor-Signature`: JWS compacto con payload separado, "<header>..<sig>".
 */
async function firmarComoSaleor(cuerpo: string, clavePrivada: KeyLike): Promise<string> {
  const jws = await new FlattenedSign(new TextEncoder().encode(cuerpo))
    .setProtectedHeader({ alg: 'RS256', b64: false, crit: ['b64'] })
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

beforeAll(async () => {
  // Generar RSA es caro (~100 ms); se hace una sola vez para toda la suite.
  parLegitimo = await generateKeyPair('RS256')
  parAtacante = await generateKeyPair('RS256')
})

beforeEach(async () => {
  // Ojo: `vi.resetModules()` descarta el módulo bajo prueba (y con él su
  // `jwksCache`), pero NO reinstancia el mock de 'jose'; el spy de
  // `createRemoteJWKSet` es el mismo durante toda la suite y acumularía
  // llamadas entre tests, de ahí el `clearAllMocks`.
  vi.clearAllMocks()
  vi.resetModules()
  jwksSimulado.clavePublica = parLegitimo.publicKey
  const modulo = await import('./index.js')
  verifySaleorWebhook = modulo.verifySaleorWebhook
  SaleorWebhookError = modulo.SaleorWebhookError
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
    // Firma emitida por una clave que NO está en el JWKS de Saleor.
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
    const causa = (error as InstanceType<ModuloBajoPrueba['SaleorWebhookError']>).cause
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
