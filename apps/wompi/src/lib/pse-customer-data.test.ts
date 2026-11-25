import { describe, it, expect } from 'vitest'
import { construirCustomerDataPse } from './pse-customer-data.js'

describe('construirCustomerDataPse', () => {
  it('arma customer_data con el celular en formato Wompi (57 + 10 dígitos) y el nombre recortado', () => {
    expect(construirCustomerDataPse('  Ana María Pérez ', '3001234567')).toEqual({
      ok: true,
      customerData: { phone_number: '573001234567', full_name: 'Ana María Pérez' },
    })
  })

  it('tolera separadores y el prefijo +57 en el celular', () => {
    const r = construirCustomerDataPse('Ana Pérez', '+57 300 123 4567')
    expect(r).toEqual({ ok: true, customerData: { phone_number: '573001234567', full_name: 'Ana Pérez' } })
  })

  it.each([undefined, null, '', '   ', 123, 'A'.repeat(121)])('rechaza el nombre %j', (nombre) => {
    const r = construirCustomerDataPse(nombre, '3001234567')
    expect(r.ok).toBe(false)
  })

  it.each([undefined, null, '', '2001234567', '300123456', '30012345678', 'abc', 3001234567])(
    'rechaza el celular %j',
    (celular) => {
      const r = construirCustomerDataPse('Ana Pérez', celular)
      expect(r.ok).toBe(false)
    },
  )

  it('los mensajes de error no contienen los datos recibidos', () => {
    const r = construirCustomerDataPse('Ana Pérez', '2001234567')
    expect(JSON.stringify(r)).not.toContain('2001234567')
    expect(JSON.stringify(r)).not.toContain('Ana')
  })
})
