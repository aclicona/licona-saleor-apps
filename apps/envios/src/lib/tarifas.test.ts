import { describe, it, expect } from 'vitest'
import { calculateTotalWeightKg, cotizarEnvios, type ShippingLine } from './tarifas.js'

/**
 * Construye una línea de checkout con el peso indicado (en kg) en la variante.
 * Si `pesoKg` es null, la variante y el producto quedan sin peso, forzando
 * el fallback de 0.5 kg por defecto.
 */
function lineaConPeso(pesoKg: number | null, quantity = 1): ShippingLine {
  return {
    quantity,
    variant: {
      weight: pesoKg === null ? null : { value: pesoKg, unit: 'kg' },
      product: { weight: null },
    },
  }
}

describe('calculateTotalWeightKg — peso total del checkout', () => {
  it('usa el fallback de 0.5 kg cuando ni la variante ni el producto tienen peso', () => {
    const lineas = [lineaConPeso(null, 1)]
    expect(calculateTotalWeightKg(lineas)).toBe(0.5)
  })

  it('multiplica el fallback de 0.5 kg por la cantidad: quantity 4 da 2 kg', () => {
    // Esta es una decisión de negocio silenciosa: un producto sin peso
    // declarado no pesa 0 kg, pesa 0.5 kg por unidad.
    const lineas = [lineaConPeso(null, 4)]
    expect(calculateTotalWeightKg(lineas)).toBe(2)
  })

  it('usa el peso del producto cuando la variante no tiene peso propio', () => {
    const linea: ShippingLine = {
      quantity: 2,
      variant: {
        weight: null,
        product: { weight: { value: 1.2, unit: 'kg' } },
      },
    }
    expect(calculateTotalWeightKg([linea])).toBe(2.4)
  })

  it('prioriza el peso de la variante sobre el del producto cuando ambos existen', () => {
    const linea: ShippingLine = {
      quantity: 1,
      variant: {
        weight: { value: 3, unit: 'kg' },
        product: { weight: { value: 999, unit: 'kg' } },
      },
    }
    expect(calculateTotalWeightKg([linea])).toBe(3)
  })

  it('suma el peso combinado de varias líneas con cantidades distintas', () => {
    const lineas = [lineaConPeso(1, 2), lineaConPeso(0.5, 3), lineaConPeso(null, 2)]
    // 1*2 + 0.5*3 + 0.5*2 = 2 + 1.5 + 1 = 4.5
    expect(calculateTotalWeightKg(lineas)).toBeCloseTo(4.5, 5)
  })
})

describe('cotizarEnvios — cotización de las tres transportadoras', () => {
  it('a exactamente 1 kg cada transportadora cobra solo su tarifa base, sin recargo', () => {
    // 1 kg es la frontera de max(0, kg - 1): el recargo debe ser cero.
    const [servientrega, coordinadora, tcc] = cotizarEnvios(1)
    expect(servientrega.amount).toBe(8000)
    expect(coordinadora.amount).toBe(9000)
    expect(tcc.amount).toBe(10000)
  })

  it('con un peso por debajo de 1 kg (0.5) tampoco hay recargo — el cliente no paga menos que la base', () => {
    // max(0, kg - 1) impide que un peso liviano genere un precio menor a la
    // tarifa base, y mucho menos uno negativo.
    const [servientrega, coordinadora, tcc] = cotizarEnvios(0.5)
    expect(servientrega.amount).toBe(8000)
    expect(coordinadora.amount).toBe(9000)
    expect(tcc.amount).toBe(10000)
  })

  it('nunca devuelve un amount negativo ni menor a la tarifa base para pesos muy pequeños', () => {
    const cotizaciones = cotizarEnvios(0.01)
    for (const cotizacion of cotizaciones) {
      expect(cotizacion.amount).toBeGreaterThanOrEqual(8000)
    }
  })

  it('con varios kilos el recargo es proporcional y mantiene el orden de precios base', () => {
    // A 3 kg: 2 kg de recargo sobre la base.
    // Servientrega: 8000 + 2*2000 = 12000
    // Coordinadora: 9000 + 2*1800 = 12600
    // TCC:          10000 + 2*1500 = 13000
    const [servientrega, coordinadora, tcc] = cotizarEnvios(3)
    expect(servientrega.amount).toBe(12000)
    expect(coordinadora.amount).toBe(12600)
    expect(tcc.amount).toBe(13000)
    expect(servientrega.amount).toBeLessThan(coordinadora.amount)
    expect(coordinadora.amount).toBeLessThan(tcc.amount)
  })

  it('todo amount es un entero para pesos fraccionarios como 2.3 kg', () => {
    // COP no admite decimales en la práctica: el redondeo debe aplicarse
    // siempre, no solo en los casos "redondos".
    const cotizaciones = cotizarEnvios(2.3)
    for (const cotizacion of cotizaciones) {
      expect(Number.isInteger(cotizacion.amount)).toBe(true)
    }
  })

  it('devuelve los tres métodos con id, currency y días de entrega correctos', () => {
    const cotizaciones = cotizarEnvios(1)
    expect(cotizaciones.map((c) => c.id)).toEqual([
      'servientrega-estandar',
      'coordinadora-estandar',
      'tcc-express',
    ])
    for (const cotizacion of cotizaciones) {
      expect(cotizacion.currency).toBe('COP')
    }
    const tcc = cotizaciones.find((c) => c.id === 'tcc-express')!
    expect(tcc.minimumDeliveryDays).toBe(1)
    expect(tcc.maximumDeliveryDays).toBe(2)
  })
})
