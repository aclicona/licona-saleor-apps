/**
 * `customer_data` de PSE (B-2451). Wompi lo exige a nivel de transacción para PSE
 * (422 «customer_data: No está presente» en producción, 2026-11-25). La subscription del
 * webhook no trae nombre ni teléfono, así que el storefront los manda dentro de `data`
 * (`customer_full_name`, `customer_phone_number`) y se validan aquí, en la frontera.
 * Formato del teléfono según el ejemplo PSE de la doc de Wompi: `57` + 10 dígitos, sin `+`.
 */

export interface CustomerDataPse {
  phone_number: string
  full_name: string
}

export type ResultadoCustomerDataPse = { ok: true; customerData: CustomerDataPse } | { ok: false; message: string }

const NOMBRE_MAX = 120
const CELULAR_CO = /^3\d{9}$/

export function construirCustomerDataPse(nombre: unknown, celular: unknown): ResultadoCustomerDataPse {
  const fullName = typeof nombre === 'string' ? nombre.trim().replace(/\s+/g, ' ') : ''
  if (!fullName || fullName.length > NOMBRE_MAX) {
    return { ok: false, message: 'Ingresa tu nombre completo para pagar con PSE.' }
  }
  const digitos = typeof celular === 'string' ? celular.replace(/\D/g, '') : ''
  const local = digitos.length === 12 && digitos.startsWith('57') ? digitos.slice(2) : digitos
  if (!CELULAR_CO.test(local)) {
    return { ok: false, message: 'Ingresa un celular colombiano válido de 10 dígitos para pagar con PSE.' }
  }
  return { ok: true, customerData: { phone_number: `57${local}`, full_name: fullName } }
}
