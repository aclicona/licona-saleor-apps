import { describe, it, expect } from 'vitest'
import { resumenPago } from './resumen-pago.js'

const eventoConPII = {
  event: 'transaction.updated',
  data: {
    transaction: {
      id: 'wompi-1',
      reference: 'TransactionItem:abc',
      status: 'APPROVED',
      amount_in_cents: 1500000,
      currency: 'COP',
      created_at: '2026-10-17T10:00:00.000Z',
      customer_email: 'cliente@example.com',
      customer_data: { full_name: 'Ana Pérez', phone_number: '3001112233' },
      shipping_address: { address_line_1: 'Calle 1 # 2-3' },
      payment_method: { type: 'CARD', extra: { last_four: '4242' } },
    },
  },
  signature: { checksum: 'secreto', properties: ['transaction.id'] },
}

describe('resumenPago (B-1374)', () => {
  it('conserva referencia, estado, importe y fecha', () => {
    expect(resumenPago(eventoConPII)).toEqual({
      evento: 'transaction.updated',
      referencia: 'TransactionItem:abc',
      estado: 'APPROVED',
      amountInCents: 1500000,
      currency: 'COP',
      fecha: '2026-10-17T10:00:00.000Z',
    })
  })

  it('no deja pasar correo, nombre, teléfono, dirección, medio de pago ni firma', () => {
    const salida = JSON.stringify(resumenPago(eventoConPII))
    for (const dato of ['cliente@example.com', 'Ana Pérez', '3001112233', 'Calle 1', '4242', 'CARD', 'secreto', 'wompi-1']) {
      expect(salida).not.toContain(dato)
    }
  })

  it('sin data.transaction registra solo el evento, sin volcar el cuerpo', () => {
    const salida = resumenPago({ event: 'x', data: {}, customer_email: 'a@b.co' })
    expect(salida).toEqual({ evento: 'x', referencia: null, estado: null, amountInCents: null, currency: null, fecha: null })
  })

  it('descarta valores que no son primitivos o cadenas planas', () => {
    const salida = resumenPago({ data: { transaction: { reference: { email: 'a@b.co' }, status: ['x'], amount_in_cents: '5' } } })
    expect(salida.referencia).toBeNull()
    expect(salida.estado).toBeNull()
    expect(salida.amountInCents).toBeNull()
  })

  it('tolera entradas no objeto', () => {
    expect(resumenPago(undefined).referencia).toBeNull()
    expect(resumenPago('texto con a@b.co').evento).toBeNull()
  })
})
