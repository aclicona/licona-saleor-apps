import { describe, it, expect, vi } from 'vitest'
import { consultarWebhooksRegistrados, detectarDeriva, type WebhookEsperado, type WebhookRegistrado } from './deriva.js'

const esperado: WebhookEsperado = {
  name: 'Carga',
  targetUrl: 'https://app/api/webhooks/carga',
  query: 'subscription {\n  event { ... on X { id } }\n}',
  syncEvents: ['TRANSACTION_CHARGE_REQUESTED'],
}
const registrado: WebhookRegistrado = {
  name: 'Carga',
  targetUrl: 'https://app/api/webhooks/carga',
  isActive: true,
  subscriptionQuery: 'subscription { event { ... on X { id } } }',
  syncEvents: ['TRANSACTION_CHARGE_REQUESTED'],
  asyncEvents: [],
}

describe('detectarDeriva', () => {
  it('sin deriva cuando solo cambia el espaciado de la query', () => {
    expect(detectarDeriva([esperado], [registrado])).toEqual([])
  })

  it('detecta una query congelada distinta a la del manifiesto nuevo', () => {
    const nuevo = { ...esperado, query: 'subscription { event { ... on X { id amount } } }' }
    expect(detectarDeriva([nuevo], [registrado]).map((d) => d.tipo)).toEqual(['QUERY_DISTINTA'])
  })

  it('detecta webhook ausente, sobrante, inactivo y eventos distintos', () => {
    expect(detectarDeriva([esperado], []).map((d) => d.tipo)).toEqual(['AUSENTE_EN_SALEOR'])
    const otro = { ...registrado, targetUrl: 'https://app/api/webhooks/viejo', name: 'Viejo' }
    expect(detectarDeriva([esperado], [registrado, otro]).map((d) => d.tipo)).toEqual(['SOBRANTE_EN_SALEOR'])
    expect(detectarDeriva([esperado], [{ ...registrado, isActive: false }]).map((d) => d.tipo)).toEqual(['INACTIVO'])
    expect(detectarDeriva([esperado], [{ ...registrado, syncEvents: [] }]).map((d) => d.tipo)).toEqual(['EVENTOS_DISTINTOS'])
  })
})

describe('consultarWebhooksRegistrados', () => {
  const respuesta = (cuerpo: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(cuerpo), { status })) as unknown as typeof fetch

  it('aplana eventType y envía el token de la App', async () => {
    const fetchFn = respuesta({
      data: { app: { webhooks: [{ ...registrado, syncEvents: [{ eventType: 'A' }], asyncEvents: [] }] } },
    })
    const r = await consultarWebhooksRegistrados({ saleorApiUrl: 'https://s/graphql/', appToken: 'tok', fetchFn })
    expect(r[0].syncEvents).toEqual(['A'])
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]
    expect(url).toBe('https://s/graphql/')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('lanza si Saleor no devuelve la App o responde con error', async () => {
    const op = { saleorApiUrl: 'https://s/graphql/', appToken: 't' }
    await expect(consultarWebhooksRegistrados({ ...op, fetchFn: respuesta({ data: { app: null } }) })).rejects.toThrow(/token/)
    await expect(consultarWebhooksRegistrados({ ...op, fetchFn: respuesta({}, 502) })).rejects.toThrow(/502/)
    await expect(consultarWebhooksRegistrados({ ...op, fetchFn: respuesta({ errors: [{ message: 'x' }] }) })).rejects.toThrow(/x/)
  })
})

import { avisarDerivaAlArranque } from './deriva.js'

describe('avisarDerivaAlArranque', () => {
  const log = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })
  const fetchCon = (webhooks: unknown[]) =>
    vi.fn(async () => new Response(JSON.stringify({ data: { app: { webhooks } } }))) as unknown as typeof fetch
  const base = { saleorApiUrl: 'https://s/graphql/', appToken: 't', webhooksManifiesto: [esperado] }

  it('escribe log error cuando hay deriva', async () => {
    const l = log()
    const fetchFn = fetchCon([{ ...registrado, subscriptionQuery: 'subscription { viejo }', syncEvents: [{ eventType: 'TRANSACTION_CHARGE_REQUESTED' }], asyncEvents: [] }])
    const r = await avisarDerivaAlArranque({ ...base, log: l, fetchFn })
    expect(r?.[0].tipo).toBe('QUERY_DISTINTA')
    expect(l.error).toHaveBeenCalledTimes(1)
  })

  it('no lanza si Saleor falla, y sin token no consulta', async () => {
    const l = log()
    const falla = vi.fn(async () => { throw new Error('red') }) as unknown as typeof fetch
    expect(await avisarDerivaAlArranque({ ...base, log: l, fetchFn: falla })).toBeNull()
    expect(l.warn).toHaveBeenCalled()
    expect(await avisarDerivaAlArranque({ ...base, appToken: '', log: l, fetchFn: falla })).toBeNull()
    expect(falla).toHaveBeenCalledTimes(1)
  })
})
