import { describe, it, expect, vi, beforeEach } from 'vitest'

const request = vi.fn()
vi.mock('graphql-request', () => ({
  gql: (s: TemplateStringsArray) => s.join(''),
  GraphQLClient: vi.fn().mockImplementation(() => ({ request })),
}))

import { accionesParaEvento, accionesParaResultado } from './acciones.js'
import { reportTransactionEvent } from './saleor-client.js'

describe('acciones declaradas a Saleor (B-432)', () => {
  it('respuesta síncrona: cobro exitoso habilita REFUND', () => {
    expect(accionesParaResultado('CHARGE_SUCCESS')).toEqual(['REFUND'])
  })
  it('respuesta síncrona: autorización habilita CHARGE y CANCEL', () => {
    expect(accionesParaResultado('AUTHORIZATION_SUCCESS')).toEqual(['CHARGE', 'CANCEL'])
  })
  it('respuesta síncrona: acción requerida o fallo no habilitan nada', () => {
    expect(accionesParaResultado('CHARGE_ACTION_REQUIRED')).toEqual([])
    expect(accionesParaResultado('CHARGE_FAILURE')).toEqual([])
  })
  it('evento: CHARGE_SUCCESS y REFUND_SUCCESS (parcial) mantienen REFUND; fallos no', () => {
    expect(accionesParaEvento('CHARGE_SUCCESS')).toEqual(['REFUND'])
    expect(accionesParaEvento('REFUND_SUCCESS')).toEqual(['REFUND'])
    expect(accionesParaEvento('CHARGE_FAILURE')).toEqual([])
    expect(accionesParaEvento('CANCEL_SUCCESS')).toEqual([])
  })
})

describe('reportTransactionEvent envía availableActions', () => {
  beforeEach(() => {
    process.env.SALEOR_API_URL = 'http://saleor/graphql/'
    process.env.SALEOR_APP_TOKEN = 't'
    request.mockReset()
    request.mockResolvedValue({ transactionEventReport: { alreadyProcessed: false, transaction: { id: 'x' }, errors: [] } })
  })

  it('CHARGE_SUCCESS → [REFUND], declarado en el documento y en las variables', async () => {
    await reportTransactionEvent({ transactionId: 'x', type: 'CHARGE_SUCCESS', amount: 1, pspReference: 'p' })
    const arg = request.mock.calls[0][0]
    expect(arg.variables.availableActions).toEqual(['REFUND'])
    expect(arg.document).toContain('$availableActions: [TransactionActionEnum!]')
    expect(arg.document).toContain('availableActions: $availableActions')
  })

  it('CHARGE_FAILURE → []', async () => {
    await reportTransactionEvent({ transactionId: 'x', type: 'CHARGE_FAILURE', amount: 1, pspReference: 'p' })
    expect(request.mock.calls[0][0].variables.availableActions).toEqual([])
  })
})
