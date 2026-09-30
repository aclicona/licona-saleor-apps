import { describe, it, expect } from 'vitest'
import { validarSubscriptions } from './subscriptions.js'

const ESQUEMA = `
  type Query { _: Boolean }
  type Money { amount: Float! currency: String! }
  type TransactionAction { amount: Money }
  type TransactionChargeRequested { action: TransactionAction! }
  union Event = TransactionChargeRequested
  type Subscription { event: Event }
  schema { query: Query subscription: Subscription }
`

describe('validarSubscriptions', () => {
  it('no da errores para una query válida', () => {
    const q = 'subscription { event { ... on TransactionChargeRequested { action { amount { amount } } } } }'
    expect(validarSubscriptions([{ name: 'ok', query: q }], ESQUEMA)).toEqual([])
  })

  it('detecta un campo que el esquema ya no tiene (deriva tras un sync)', () => {
    const q = 'subscription { event { ... on TransactionChargeRequested { action { monto } } } }'
    const r = validarSubscriptions([{ name: 'carga', query: q }], ESQUEMA)
    expect(r).toHaveLength(1)
    expect(r[0].webhook).toBe('carga')
    expect(r[0].mensaje).toContain('monto')
  })

  it('reporta sintaxis inválida sin lanzar', () => {
    const r = validarSubscriptions([{ name: 'rota', query: 'subscription {' }], ESQUEMA)
    expect(r[0].mensaje).toMatch(/sintaxis/)
  })
})
