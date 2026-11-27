import { describe, it, expect, vi, beforeEach } from 'vitest'

const request = vi.fn()
const rawRequest = vi.fn()
const opciones = vi.fn()
vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...vals: unknown[]) => strings.reduce((a, s, i) => a + s + (vals[i] ?? ''), ''),
  GraphQLClient: class {
    request = request
    rawRequest = rawRequest
    constructor(_url: string, config: unknown) {
      opciones(config)
    }
  },
}))

import { readFileSync } from 'node:fs'
import { validarSubscriptions } from '@licona/webhook-utils'
import {
  QUERY_TRANSACCIONES_DE_CHECKOUT,
  listarTransaccionesConSolicitud,
  obtenerTransaccionesDelCheckout,
  reportTransactionEvent,
  MAX_PAGINAS_SOLICITUDES,
} from './saleor-client.js'

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

describe('obtenerTransaccionesDelCheckout (B-2616)', () => {
  beforeEach(() => {
    rawRequest.mockReset()
    opciones.mockReset()
    process.env.SALEOR_API_URL = 'https://saleor.test/graphql/'
    process.env.SALEOR_APP_TOKEN = 'tok'
  })
  const señal = () => new AbortController().signal
  const autor = { __typename: 'App', id: 'A1' }
  const transaccion = {
    id: 'T1',
    pspReference: 'p',
    createdAt: '2026-11-27T12:00:00Z',
    createdBy: autor,
    events: [{ type: 'CHARGE_REQUEST', pspReference: 'p', createdBy: autor }],
  }

  it('devuelve la App propia y las transacciones del checkout', async () => {
    rawRequest.mockResolvedValue({ data: { app: { id: 'A1' }, checkout: { transactions: [transaccion] } } })

    await expect(obtenerTransaccionesDelCheckout('C1', señal())).resolves.toEqual({
      appId: 'A1',
      transacciones: [transaccion],
      erroresParciales: [],
    })
    expect(rawRequest.mock.calls[0][0].variables).toEqual({ id: 'C1' })
    expect(rawRequest.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal)
    expect(opciones).toHaveBeenCalledWith(expect.objectContaining({ errorPolicy: 'all' }))
  })

  it('tolera errores parciales y los devuelve para el log', async () => {
    rawRequest.mockResolvedValue({
      data: { app: null, checkout: { transactions: [{ ...transaccion, createdBy: null }] } },
      errors: [{ message: 'no se pudo resolver createdBy' }],
    })

    await expect(obtenerTransaccionesDelCheckout('C1', señal())).resolves.toMatchObject({
      appId: undefined,
      transacciones: [{ id: 'T1', createdBy: null }],
      erroresParciales: ['no se pudo resolver createdBy'],
    })
  })

  it('la señal se corta con el plazo recibido', async () => {
    rawRequest.mockResolvedValue({ data: { checkout: { transactions: [] } } })
    const plazo = new AbortController()
    await obtenerTransaccionesDelCheckout('C1', plazo.signal)
    plazo.abort()
    expect(rawRequest.mock.calls[0][0].signal.aborted).toBe(true)
  })

  it.each([
    ['checkout inexistente', { checkout: null }],
    ['lista anulada por un error', { checkout: { transactions: null } }],
    ['sin data', undefined],
  ])('%s: lanza (no se puede afirmar que no haya transacciones)', async (_nombre, data) => {
    rawRequest.mockResolvedValue({ data, errors: [{ message: 'x' }] })
    await expect(obtenerTransaccionesDelCheckout('C1', señal())).rejects.toThrow('checkout')
  })

  // El esquema vive en el fork (como en `check:subscriptions`): se valida cuando SALEOR_SCHEMA_PATH está definida.
  it.skipIf(!process.env.SALEOR_SCHEMA_PATH)('la query es válida contra el esquema del fork', () => {
    const esquema = readFileSync(process.env.SALEOR_SCHEMA_PATH as string, 'utf8')
    expect(validarSubscriptions([{ name: 'TransaccionesDeCheckout', query: QUERY_TRANSACCIONES_DE_CHECKOUT }], esquema)).toEqual([])
  })
})
