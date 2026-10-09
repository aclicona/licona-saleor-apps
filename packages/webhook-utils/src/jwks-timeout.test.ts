// B-1105: el tope de la descarga del JWKS (5 s) que da por supuesto el test-contrato del plazo
// (apps/*/src/webhooks/contrato-plazo.test.ts) lo pone `jose` por defecto, no nuestro código. Este test
// lo ata a la realidad: un JWKS que acepta la conexión y nunca responde debe rechazar como
// `jwks_unavailable` en ~5 s. Si una actualización de `jose` cambia el default, falla aquí y no en un pago.
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { verifySaleorWebhook, SaleorWebhookError, clearJwksCache } from './index.js'

const JWKS_TOPE_ESPERADO_MS = 5_000
const MARGEN_MS = 1_500

let servidor: Server | undefined
afterEach(async () => {
  clearJwksCache()
  const abierto = servidor
  servidor = undefined
  if (abierto) {
    abierto.closeAllConnections()
    await new Promise<void>((res) => abierto.close(() => res()))
  }
})

describe('descarga del JWKS con el servidor mudo', () => {
  it('rechaza como jwks_unavailable en ~5 s (default de jose)', async () => {
    servidor = createServer(() => {
      /* acepta la petición y no responde jamás */
    })
    await new Promise<void>((res) => servidor!.listen(0, '127.0.0.1', res))
    const { port } = servidor.address() as AddressInfo
    const cabecera = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k', crit: ['b64'], b64: false })).toString('base64url')

    const t0 = Date.now()
    const error = await verifySaleorWebhook('{}', `${cabecera}..c2ln`, `http://127.0.0.1:${port}/graphql/`).catch((e) => e)
    const duracion = Date.now() - t0

    expect(error).toBeInstanceOf(SaleorWebhookError)
    expect((error as SaleorWebhookError).reason).toBe('jwks_unavailable')
    expect(duracion).toBeGreaterThanOrEqual(JWKS_TOPE_ESPERADO_MS - 500)
    expect(duracion).toBeLessThan(JWKS_TOPE_ESPERADO_MS + MARGEN_MS)
  }, 15_000)
})
