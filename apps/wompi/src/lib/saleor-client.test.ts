import { describe, it, expect, vi, beforeEach } from 'vitest'

const request = vi.fn()
vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...vals: unknown[]) => strings.reduce((a, s, i) => a + s + (vals[i] ?? ''), ''),
  GraphQLClient: class {
    request = request
  },
}))

import { listarTransaccionesConSolicitud, reportTransactionEvent, MAX_PAGINAS_SOLICITUDES } from './saleor-client.js'

const nodo = (id: string) => ({
  node: {
    id,
    cancelPendingAmount: { amount: '120000' },
    refundPendingAmount: { amount: 0 },
    events: [{ type: 'CANCEL_REQUEST', pspReference: 'psp-A', createdAt: '2026-10-08T11:00:00Z', amount: { amount: 120000.5 } }],
  },
})
const pagina = (ids: string[], hasNextPage: boolean, endCursor: string | null = null) => ({
  transactions: { pageInfo: { hasNextPage, endCursor }, edges: ids.map(nodo) },
})

describe('listarTransaccionesConSolicitud', () => {
  beforeEach(() => {
    request.mockReset()
    process.env.SALEOR_API_URL = 'https://saleor.test/graphql/'
    process.env.SALEOR_APP_TOKEN = 'tok'
  })

  it('manda tipo y desde, mapea los importes a number y pagina con after', async () => {
    request.mockResolvedValueOnce(pagina(['T1'], true, 'c1')).mockResolvedValueOnce(pagina(['T2'], false))
    const desde = new Date('2026-10-07T00:00:00Z')
    const r = await listarTransaccionesConSolicitud({ tipo: 'CANCEL_REQUEST', desde })

    expect(r.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(r[0]).toMatchObject({ cancelPendingAmount: 120000, refundPendingAmount: 0 })
    expect(r[0].events[0].amount).toBe(120000.5)
    expect(request.mock.calls[0][0].variables).toEqual({ tipo: 'CANCEL_REQUEST', desde: desde.toISOString(), after: null })
    expect(request.mock.calls[1][0].variables.after).toBe('c1')
  })

  it('respeta el tope de páginas y avisa', async () => {
    request.mockResolvedValue(pagina(['T'], true, 'c'))
    const alLlegarAlTope = vi.fn()
    await listarTransaccionesConSolicitud({ tipo: 'CANCEL_REQUEST', desde: new Date(), alLlegarAlTope })
    expect(request).toHaveBeenCalledTimes(MAX_PAGINAS_SOLICITUDES)
    expect(alLlegarAlTope).toHaveBeenCalledTimes(1)
  })

  it('lanza si falla el transporte', async () => {
    request.mockRejectedValue(new Error('red'))
    await expect(listarTransaccionesConSolicitud({ tipo: 'CANCEL_REQUEST', desde: new Date() })).rejects.toThrow('red')
  })
})

describe('reportTransactionEvent: availableActions', () => {
  const base = { transactionId: 'T1', amount: 100, pspReference: 'p', message: 'm' }
  beforeEach(() => {
    request.mockReset()
    request.mockResolvedValue({ transactionEventReport: { alreadyProcessed: false, transaction: { id: 'T1' }, errors: [] } })
    process.env.SALEOR_API_URL = 'https://saleor.test/graphql/'
    process.env.SALEOR_APP_TOKEN = 'tok'
  })
  const vars = () => request.mock.calls[0][0].variables

  it('INFO: la variable availableActions no viaja (ni siquiera como [])', async () => {
    await reportTransactionEvent({ ...base, type: 'INFO', availableActions: undefined })
    expect(vars().availableActions).toBeUndefined()
    expect(JSON.stringify(vars())).not.toContain('availableActions')
    expect(vars().type).toBe('INFO')
  })

  it('INFO ignora availableActions explícitas', async () => {
    await reportTransactionEvent({ ...base, type: 'INFO', availableActions: ['REFUND'] })
    expect(vars().availableActions).toBeUndefined()
  })

  it('CHARGE_SUCCESS sin parámetro sigue declarando REFUND', async () => {
    await reportTransactionEvent({ ...base, type: 'CHARGE_SUCCESS' })
    expect(vars().availableActions).toEqual(['REFUND'])
  })

  it('CANCEL_SUCCESS sin parámetro sigue mandando [] como hoy', async () => {
    await reportTransactionEvent({ ...base, type: 'CANCEL_SUCCESS' })
    expect(vars().availableActions).toEqual([])
  })
})
