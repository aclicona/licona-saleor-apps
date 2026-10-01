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

import { comprobarDerivaDesdeManifiesto, crearSeguimientoDeriva } from './deriva.js'
import { verificarCadena } from './salud.js'

describe('seguimiento de deriva para el healthcheck (B-406)', () => {
  const l = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })
  const fetchCon = (webhooks: unknown[]) =>
    vi.fn(async () => new Response(JSON.stringify({ data: { app: { webhooks } } }))) as unknown as typeof fetch
  const base = { saleorApiUrl: 'https://s/graphql/', appToken: 't', webhooksManifiesto: [esperado] }

  it('sin deriva → sano', async () => {
    const seguimiento = crearSeguimientoDeriva()
    expect(seguimiento.obtener().estado).toBe('sin_comprobar')
    await avisarDerivaAlArranque({ ...base, log: l(), fetchFn: fetchCon([{ ...registrado, subscriptionQuery: esperado.query, syncEvents: [{ eventType: 'TRANSACTION_CHARGE_REQUESTED' }], asyncEvents: [] }]), seguimiento })
    expect(seguimiento.obtener().estado).toBe('sano')
  })

  it('con deriva → estado deriva con el detalle', async () => {
    const seguimiento = crearSeguimientoDeriva()
    await avisarDerivaAlArranque({ ...base, log: l(), fetchFn: fetchCon([]), seguimiento })
    expect(seguimiento.obtener().estado).toBe('deriva')
    expect(seguimiento.obtener().deriva?.[0].tipo).toBe('AUSENTE_EN_SALEOR')
  })

  it('error de consulta → desconocido (no deriva) y logueado', async () => {
    const seguimiento = crearSeguimientoDeriva()
    const log = l()
    const fetchFn = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await avisarDerivaAlArranque({ ...base, log, fetchFn, seguimiento })
    expect(seguimiento.obtener()).toMatchObject({ estado: 'desconocido', motivo: 'ECONNREFUSED' })
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('sin token no comprueba y queda sin_comprobar', async () => {
    const seguimiento = crearSeguimientoDeriva()
    await avisarDerivaAlArranque({ ...base, appToken: '', log: l(), seguimiento })
    expect(seguimiento.obtener().estado).toBe('sin_comprobar')
  })

  it('comprobarDerivaDesdeManifiesto nunca rechaza si falla obtener el manifiesto', async () => {
    const seguimiento = crearSeguimientoDeriva()
    const log = l()
    await expect(
      comprobarDerivaDesdeManifiesto({
        obtenerWebhooksManifiesto: async () => { throw new Error('inject roto') },
        saleorApiUrl: 'https://s/graphql/', appToken: 't', log, seguimiento,
      }),
    ).resolves.toBeUndefined()
    expect(seguimiento.obtener()).toMatchObject({ estado: 'desconocido', motivo: 'inject roto' })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('comprobarDerivaDesdeManifiesto no rechaza ni con un logger que lanza', async () => {
    const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(() => { throw new Error('log roto') }) }
    await expect(
      comprobarDerivaDesdeManifiesto({
        obtenerWebhooksManifiesto: async () => { throw new Error('x') },
        saleorApiUrl: 'https://s/graphql/', appToken: 't', log,
      }),
    ).resolves.toBeUndefined()
  })
})

describe('verificarCadena con deriva', () => {
  const fetchFn = (async (u: string) =>
    new Response(String(u).endsWith('jwks.json') ? '{"keys":[{"kid":"a"}]}' : '{"data":{}}')) as unknown as typeof fetch
  const op = { saleorApiUrl: 'https://s/graphql/', variablesFaltantes: [], fetchFn }

  it('sin deriva informada no añade el eslabón', async () => {
    const r = await verificarCadena(op)
    expect(r.ok).toBe(true)
    expect(r.checks).not.toHaveProperty('deriva')
  })
  it('sano → ok; desconocido → ok con detalle; deriva → rojo legible', async () => {
    expect((await verificarCadena({ ...op, deriva: { estado: 'sano' } })).ok).toBe(true)
    const desc = await verificarCadena({ ...op, deriva: { estado: 'desconocido', motivo: 'timeout' } })
    expect(desc.ok).toBe(true)
    expect(desc.checks.deriva?.detalle).toContain('timeout')
    const rojo = await verificarCadena({ ...op, deriva: { estado: 'deriva', deriva: [{ webhook: 'w', tipo: 'QUERY_DISTINTA', detalle: 'd' }] } })
    expect(rojo.ok).toBe(false)
    expect(rojo.checks.deriva?.detalle).toContain('w (QUERY_DISTINTA)')
  })
})
