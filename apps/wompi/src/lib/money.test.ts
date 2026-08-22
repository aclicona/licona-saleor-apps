import { describe, it, expect } from 'vitest'
import { copToCents } from './money.js'

describe('copToCents — conversión COP → centavos de Wompi', () => {
  it('convierte el caso canónico documentado en el proyecto: 120000 COP → 12000000 centavos', () => {
    expect(copToCents(120000)).toBe(12000000)
  })

  it('resuelve el caso trampa de punto flotante donde la multiplicación cruda falla', () => {
    // En JS, 19.99 * 100 NO da 1999 exacto: da 1998.9999999999998.
    // Si el código confiara en la multiplicación cruda (o la truncara con
    // Math.trunc/Math.floor en vez de redondear), el cliente pagaría un
    // centavo menos de lo que debe.
    expect(19.99 * 100).not.toBe(1999)
    expect(19.99 * 100).toBeCloseTo(1999, 5)
    expect(Number.isInteger(19.99 * 100)).toBe(false)

    // copToCents sí debe dar el entero correcto.
    expect(copToCents(19.99)).toBe(1999)
  })

  it('absorbe el residuo de punto flotante que deja el almacenamiento de 3 decimales de Saleor', () => {
    // Saleor guarda importes con 3 decimales (DEFAULT_DECIMAL_PLACES = 3,
    // global, no configurable por moneda) aunque COP no use decimales en la
    // práctica. Un importe "limpio" puede llegar como 120000.004 por ese
    // residuo — se redondea al centavo más cercano, no se rechaza.
    expect(copToCents(120000.004)).toBe(12000000)
  })

  it('redondea al centavo más cercano cuando el residuo cae justo en el borde', () => {
    expect(copToCents(120000.006)).toBe(12000001)
  })

  it('siempre devuelve un entero para cualquier entrada válida', () => {
    const entradas = [0, 1, 100, 999.999, 120000, 120000.004, 5000.5, 1_000_000.123]
    for (const cop of entradas) {
      const resultado = copToCents(cop)
      expect(Number.isInteger(resultado)).toBe(true)
    }
  })

  it('convierte 0 COP a 0 centavos sin lanzar (un importe cero es válido, aunque inusual)', () => {
    expect(copToCents(0)).toBe(0)
  })

  it('lanza en vez de convertir en silencio cuando el importe es NaN', () => {
    expect(() => copToCents(NaN)).toThrow()
  })

  it('lanza en vez de convertir en silencio cuando el importe es Infinity', () => {
    expect(() => copToCents(Infinity)).toThrow()
    expect(() => copToCents(-Infinity)).toThrow()
  })

  it('lanza en vez de convertir en silencio cuando el importe es negativo', () => {
    // Un cobro negativo no tiene sentido de negocio: nunca debe llegar a
    // Wompi como un amount_in_cents negativo.
    expect(() => copToCents(-120000)).toThrow()
  })

  it('lanza en vez de convertir en silencio cuando el importe es undefined', () => {
    // action.amount podría venir undefined si el payload de Saleor está
    // malformado; no debe colarse como NaN o 0 hacia el cobro real.
    expect(() => copToCents(undefined as unknown as number)).toThrow()
  })

  it('lanza en vez de convertir en silencio cuando el importe no es un número (string)', () => {
    expect(() => copToCents('120000' as unknown as number)).toThrow()
  })
})
