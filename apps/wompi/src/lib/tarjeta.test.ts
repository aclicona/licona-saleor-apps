import { describe, it, expect } from 'vitest'
import { validarDatosTarjeta } from './tarjeta.js'

describe('validarDatosTarjeta', () => {
  it('acepta token válido y usa 1 cuota por defecto', () => {
    expect(validarDatosTarjeta({ token: 'tok_test_123_abc' })).toEqual({ ok: true, tarjeta: { token: 'tok_test_123_abc', installments: 1 } })
  })

  it.each([1, 12, 36])('acepta %i cuotas', (n) => {
    expect(validarDatosTarjeta({ token: 'tok_prod_1_x', installments: n })).toMatchObject({ ok: true, tarjeta: { installments: n } })
  })

  it.each([undefined, null, '', 'abc', 'xyz_123', 'TOK_123', 'tok_', 'tok_a b', 'tok_<script>', 42, {}, ['tok_1'], 'tok_' + 'a'.repeat(121)])(
    'rechaza el token %j',
    (token) => {
      expect(validarDatosTarjeta({ token })).toMatchObject({ ok: false })
    },
  )

  it('rechaza si no hay data', () => {
    expect(validarDatosTarjeta(undefined)).toMatchObject({ ok: false })
  })

  it.each([0, -1, 37, 1.5, NaN, Infinity, '3', true, {}])('rechaza %j cuotas', (installments) => {
    expect(validarDatosTarjeta({ token: 'tok_test_1_a', installments })).toMatchObject({ ok: false })
  })
})
