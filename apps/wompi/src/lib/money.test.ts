import { describe, it, expect } from 'vitest'
import { centsToCop, copToCents } from './money.js'

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

describe('centsToCop — conversión centavos de Wompi → COP', () => {
  it('convierte el caso canónico documentado en el proyecto: 12000000 centavos → 120000 COP', () => {
    expect(centsToCop(12000000)).toBe(120000)
  })

  it('devuelve el valor exacto en el caso donde la multiplicación inversa falla', () => {
    // 19.99 * 100 no da 1999 en IEEE-754, pero 1999 / 100 sí da el double
    // más cercano a 19.99, y su toString() es exactamente "19.99".
    expect(centsToCop(1999)).toBe(19.99)
    expect(centsToCop(1999).toString()).toBe('19.99')
  })

  it('es la inversa exacta de copToCents para importes en COP sin decimales', () => {
    const importes = [0, 1, 100, 19.99, 120000, 5000.5, 1_000_000]
    for (const cop of importes) {
      expect(centsToCop(copToCents(cop))).toBe(cop)
    }
  })

  it('convierte 0 centavos a 0 COP sin lanzar', () => {
    expect(centsToCop(0)).toBe(0)
  })

  it('nunca produce más de 2 decimales, que es lo máximo que un centavo puede expresar', () => {
    for (const centavos of [1, 7, 99, 101, 1999, 12000000, 987654321]) {
      const cop = centsToCop(centavos)
      const decimales = (cop.toString().split('.')[1] ?? '').length
      expect(decimales).toBeLessThanOrEqual(2)
    }
  })

  it('lanza cuando los centavos no son un entero', () => {
    // Wompi documenta amount_in_cents como entero. Un valor fraccionario es
    // payload corrupto o manipulado: mejor un fallo permanente visible que
    // reportarle a Saleor un importe inventado.
    expect(() => centsToCop(1999.5)).toThrow()
    expect(() => centsToCop(0.5)).toThrow()
  })

  it('lanza cuando los centavos superan el rango entero seguro de IEEE-754', () => {
    // Por encima de 2^53 los enteros de JS dejan de ser exactos: dividir entre
    // 100 daría un importe silenciosamente distinto del que cobró Wompi.
    expect(() => centsToCop(Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })

  it('lanza cuando los centavos son NaN', () => {
    expect(() => centsToCop(NaN)).toThrow()
  })

  it('lanza cuando los centavos son Infinity', () => {
    expect(() => centsToCop(Infinity)).toThrow()
    expect(() => centsToCop(-Infinity)).toThrow()
  })

  it('lanza cuando los centavos son negativos', () => {
    expect(() => centsToCop(-12000000)).toThrow()
  })

  it('lanza cuando amount_in_cents viene undefined en el payload de Wompi', () => {
    expect(() => centsToCop(undefined as unknown as number)).toThrow()
  })

  it('lanza cuando amount_in_cents viene como string en el payload de Wompi', () => {
    // JSON.parse deja el tipo tal como venga; un "12000000" con comillas no
    // debe colarse como importe válido.
    expect(() => centsToCop('12000000' as unknown as number)).toThrow()
  })
})
