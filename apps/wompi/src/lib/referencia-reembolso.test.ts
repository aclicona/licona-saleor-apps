import { describe, it, expect } from 'vitest'
import { SEPARADOR_REEMBOLSO_SIN_ID, esReferenciaSinId } from './referencia-reembolso.js'

describe('esReferenciaSinId', () => {
  it('reconoce la referencia provisional que arma transaction-refund', () => {
    expect(esReferenciaSinId(`12084641-1791286722-99200${SEPARADOR_REEMBOLSO_SIN_ID}0b1c2d3e`)).toBe(true)
  })
  it('un id de reembolso de Wompi no es sin-id', () => {
    expect(esReferenciaSinId('123456')).toBe(false)
    expect(esReferenciaSinId('12084641-1791286722-99200')).toBe(false)
  })
})
