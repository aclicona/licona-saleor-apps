export interface ShippingLine {
  quantity: number
  variant: {
    weight: { value: number; unit: string } | null
    product: { weight: { value: number; unit: string } | null }
  }
}

export interface MetodoEnvio {
  id: string
  name: string
  amount: number
  currency: string
  maximumDeliveryDays: number
  minimumDeliveryDays: number
}

/**
 * Suma el peso total (en kg) de las líneas del checkout.
 * Fallback en cascada: peso de la variante → peso del producto → 0.5 kg
 * por defecto (decisión de negocio: un producto sin peso declarado no
 * pesa 0 kg).
 */
export function calculateTotalWeightKg(lines: ShippingLine[]): number {
  return lines.reduce((total, line) => {
    const weight = line.variant.weight?.value ?? line.variant.product.weight?.value ?? 0.5
    return total + weight * line.quantity
  }, 0)
}

/**
 * Cotiza el envío con las tres transportadoras a partir del peso total (kg).
 * Cada tarifa cubre el primer kilo con su tarifa base; el recargo por kilo
 * adicional solo aplica sobre el excedente (max(0, pesoKg - 1)), así que un
 * paquete de 1 kg o menos nunca paga menos que la tarifa base.
 */
export function cotizarEnvios(pesoKg: number): MetodoEnvio[] {
  const servientregaPrice = 8000 + Math.max(0, pesoKg - 1) * 2000
  const coordinadoraPrice = 9000 + Math.max(0, pesoKg - 1) * 1800
  const tccPrice = 10000 + Math.max(0, pesoKg - 1) * 1500

  return [
    {
      id: 'servientrega-estandar',
      name: 'Servientrega Estándar (3-5 días)',
      amount: Math.round(servientregaPrice),
      currency: 'COP',
      maximumDeliveryDays: 5,
      minimumDeliveryDays: 3,
    },
    {
      id: 'coordinadora-estandar',
      name: 'Coordinadora Estándar (3-5 días)',
      amount: Math.round(coordinadoraPrice),
      currency: 'COP',
      maximumDeliveryDays: 5,
      minimumDeliveryDays: 3,
    },
    {
      id: 'tcc-express',
      name: 'TCC Express (1-2 días)',
      amount: Math.round(tccPrice),
      currency: 'COP',
      maximumDeliveryDays: 2,
      minimumDeliveryDays: 1,
    },
  ]
}
