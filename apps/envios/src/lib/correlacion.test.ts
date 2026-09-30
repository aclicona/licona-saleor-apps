import { describe, it, expect } from 'vitest'
import { LONGITUD_MAXIMA_VALOR, camposDeCorrelacion } from './correlacion.js'

describe('camposDeCorrelacion (envios)', () => {
  it('extrae checkoutId con el nombre canónico', () => {
    expect(camposDeCorrelacion({ checkout: { id: 'Q2hlY2tvdXQ6MQ==' } })).toEqual({ checkoutId: 'Q2hlY2tvdXQ6MQ==' })
  })

  it.each([undefined, null, 'texto', 42, {}, { checkout: null }, { checkout: {} }, { checkout: { id: 7 } }, { checkout: { id: '  ' } }])(
    'nunca lanza y no devuelve campos con %j',
    (cuerpo) => {
      expect(camposDeCorrelacion(cuerpo)).toEqual({})
    }
  )

  it('descarta un id kilométrico', () => {
    expect(camposDeCorrelacion({ checkout: { id: 'x'.repeat(LONGITUD_MAXIMA_VALOR + 1) } })).toEqual({})
  })
})
