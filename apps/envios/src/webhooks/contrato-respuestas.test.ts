import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Contrato de respuestas síncronas (B-1303), gemelo del de wompi
 * (apps/wompi/src/webhooks/contrato-respuestas.test.ts; ahí está la explicación completa).
 * Saleor valida la lista con `ListShippingMethodsSchema` del fork y OMITE EN SILENCIO cada método
 * inválido (OnErrorSkip): el validador del repo raíz (`scripts/contrato-respuestas/validar.py`)
 * compara cuántos métodos entran y cuántos sobreviven.
 */

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))

import { shippingListMethodsHandler } from './shipping-list-methods.js'

const EVENTO = 'SHIPPING_LIST_METHODS_FOR_CHECKOUT'
const DIR_FIXTURES = fileURLToPath(new URL('../../contrato-respuestas/', import.meta.url))
const LINEA = { quantity: 2, variant: { weight: { value: 1.5, unit: 'KG' }, product: { weight: null } } }
const DIRECCION = { city: 'Medellín', postalCode: '050001', countryArea: 'ANT' }

const CASOS = [
  { caso: 'con_direccion', checkout: { id: 'C', shippingAddress: DIRECCION, lines: [LINEA] } },
  { caso: 'sin_direccion', checkout: { id: 'C', shippingAddress: null, lines: [LINEA] } },
]

const archivo = (caso: string) => `${EVENTO}__${caso}.json`

async function respuestaDe(checkout: unknown): Promise<unknown> {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const req = { rawBody: '{}', body: { checkout }, headers: {}, log } as unknown as FastifyRequest
  let enviado: unknown
  const reply = { status: () => reply, send: (p: unknown) => ((enviado = p), reply) }
  await shippingListMethodsHandler(req, reply as unknown as FastifyReply)
  return enviado
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('contrato de respuestas síncronas con Saleor (B-1303)', () => {
  it.each(CASOS.map((c) => [archivo(c.caso), c] as const))('%s', async (_nombre, c) => {
    const fixture = { evento: EVENTO, caso: c.caso, respuesta: await respuestaDe(c.checkout) }
    await expect(JSON.stringify(fixture, null, 2) + '\n').toMatchFileSnapshot(DIR_FIXTURES + archivo(c.caso))
  })

  it('no quedan fixtures huérfanas', () => {
    expect(readdirSync(DIR_FIXTURES).sort()).toEqual(CASOS.map((c) => archivo(c.caso)).sort())
  })
})
