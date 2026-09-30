import { describe, it, expect, vi } from 'vitest'
import { verificarCadena } from './salud.js'

const API = 'https://saleor.example.com/graphql/'

/** Doble de fetch: responde según la URL pedida. */
function dobleFetch(rutas: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    const ruta = Object.keys(rutas).find((k) => u.endsWith(k))
    if (!ruta) throw new Error(`ruta inesperada ${u}`)
    return rutas[ruta]()
  }) as unknown as typeof fetch
}

const saleorOk = () => new Response(JSON.stringify({ data: { __typename: 'Query' } }), { status: 200 })
const jwksOk = () => new Response(JSON.stringify({ keys: [{ kid: 'a', kty: 'RSA' }] }), { status: 200 })

describe('verificarCadena', () => {
  it('ok cuando config, Saleor y JWKS responden', async () => {
    const r = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: [],
      fetchFn: dobleFetch({ '/graphql/': saleorOk, '/.well-known/jwks.json': jwksOk }),
    })
    expect(r.ok).toBe(true)
    expect(r.checks.config.ok).toBe(true)
    expect(r.checks.saleor.ok).toBe(true)
    expect(r.checks.jwks.ok).toBe(true)
  })

  it('falla y nombra las variables ausentes (sin valores)', async () => {
    const r = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: ['WOMPI_PRIVATE_KEY'],
      fetchFn: dobleFetch({ '/graphql/': saleorOk, '/.well-known/jwks.json': jwksOk }),
    })
    expect(r.ok).toBe(false)
    expect(r.checks.config).toEqual({ ok: false, detalle: 'faltan: WOMPI_PRIVATE_KEY' })
    expect(r.checks.saleor.ok).toBe(true)
  })

  it('sin SALEOR_API_URL no hace red y marca saleor y jwks como fallidos', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const r = await verificarCadena({ saleorApiUrl: '', variablesFaltantes: [], fetchFn })
    expect(r.ok).toBe(false)
    expect(r.checks.saleor.ok).toBe(false)
    expect(r.checks.jwks.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('falla si Saleor no es alcanzable (error de red)', async () => {
    const r = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: [],
      fetchFn: dobleFetch({
        '/graphql/': () => { throw new Error('ECONNREFUSED') },
        '/.well-known/jwks.json': jwksOk,
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.checks.saleor).toEqual({ ok: false, detalle: 'ECONNREFUSED' })
    expect(r.checks.jwks.ok).toBe(true)
  })

  it('falla si Saleor responde 5xx', async () => {
    const r = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: [],
      fetchFn: dobleFetch({
        '/graphql/': () => new Response('x', { status: 502 }),
        '/.well-known/jwks.json': jwksOk,
      }),
    })
    expect(r.checks.saleor).toEqual({ ok: false, detalle: 'HTTP 502' })
  })

  it('falla si el JWKS no se descarga o no trae claves', async () => {
    const caido = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: [],
      fetchFn: dobleFetch({ '/graphql/': saleorOk, '/.well-known/jwks.json': () => new Response('', { status: 404 }) }),
    })
    expect(caido.checks.jwks).toEqual({ ok: false, detalle: 'HTTP 404' })

    const vacio = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: [],
      fetchFn: dobleFetch({
        '/graphql/': saleorOk,
        '/.well-known/jwks.json': () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      }),
    })
    expect(vacio.ok).toBe(false)
    expect(vacio.checks.jwks.detalle).toMatch(/sin claves/)
  })

  it('un JWKS con cuerpo no JSON falla en vez de lanzar', async () => {
    const r = await verificarCadena({
      saleorApiUrl: API,
      variablesFaltantes: [],
      fetchFn: dobleFetch({ '/graphql/': saleorOk, '/.well-known/jwks.json': () => new Response('<html>', { status: 200 }) }),
    })
    expect(r.ok).toBe(false)
    expect(r.checks.jwks.ok).toBe(false)
  })

  it('pasa una señal de timeout a cada petición', async () => {
    const fetchFn = dobleFetch({ '/graphql/': saleorOk, '/.well-known/jwks.json': jwksOk })
    await verificarCadena({ saleorApiUrl: API, variablesFaltantes: [], fetchFn })
    const llamadas = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(llamadas).toHaveLength(2)
    for (const [, init] of llamadas) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })
})
