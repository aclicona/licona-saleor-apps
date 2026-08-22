import { describe, it, expect } from 'vitest'
import { clasificarFalloSaleor } from './saleor-errors.js'

/** Imita el `ClientError` de graphql-request: lleva `response.status`. */
function errorHttp(status: number) {
  const error = new Error(`Saleor respondió ${status}`)
  return Object.assign(error, { response: { status, errors: [], headers: undefined, body: '' } })
}

/** Imita un error GraphQL de nivel superior: HTTP 200 con `errors` poblado. */
function errorGraphql(codigoExcepcion: string) {
  const error = new Error('GraphQL Error')
  return Object.assign(error, {
    response: {
      status: 200,
      errors: [{ message: codigoExcepcion, extensions: { exception: { code: codigoExcepcion } } }],
    },
  })
}

describe('clasificarFalloSaleor — decide si el reintento de Wompi puede converger', () => {
  it('clasifica un timeout como transitorio', () => {
    // AbortSignal.timeout produce un DOMException con name 'TimeoutError'.
    const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(clasificarFalloSaleor(error)).toBe('TRANSITORIO')
  })

  it('clasifica un fallo de red de fetch como transitorio', () => {
    const error = new TypeError('fetch failed')
    Object.assign(error, { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    expect(clasificarFalloSaleor(error)).toBe('TRANSITORIO')
  })

  it('clasifica un 500 de Saleor como transitorio', () => {
    expect(clasificarFalloSaleor(errorHttp(500))).toBe('TRANSITORIO')
  })

  it('clasifica un 502 y un 503 de Saleor como transitorios', () => {
    expect(clasificarFalloSaleor(errorHttp(502))).toBe('TRANSITORIO')
    expect(clasificarFalloSaleor(errorHttp(503))).toBe('TRANSITORIO')
  })

  it('clasifica un 429 (rate limit) como transitorio', () => {
    expect(clasificarFalloSaleor(errorHttp(429))).toBe('TRANSITORIO')
  })

  it('clasifica un 401 como fallo de autenticación', () => {
    // El evento es válido; lo que está roto es la instancia. Un humano rota
    // el token y el siguiente reintento entra solo.
    expect(clasificarFalloSaleor(errorHttp(401))).toBe('AUTENTICACION')
  })

  it('clasifica un 403 como fallo de autenticación', () => {
    expect(clasificarFalloSaleor(errorHttp(403))).toBe('AUTENTICACION')
  })

  it('detecta PermissionDenied aunque Saleor responda HTTP 200', () => {
    // Saleor devuelve 200 con un error GraphQL cuando el token es válido pero
    // le faltan permisos: el status por sí solo no lo detecta.
    expect(clasificarFalloSaleor(errorGraphql('PermissionDenied'))).toBe('AUTENTICACION')
  })

  it('detecta una firma de JWT expirada aunque Saleor responda HTTP 200', () => {
    expect(clasificarFalloSaleor(errorGraphql('ExpiredSignatureError'))).toBe('AUTENTICACION')
  })

  it('ante un error desconocido cae del lado seguro: transitorio', () => {
    // Preferimos que Wompi reintente (coste: ruido en el log, y Saleor
    // deduplica igual) antes que dar por entregado un evento que quizá nunca
    // llegó (coste: un cobro real sin orden pagada).
    expect(clasificarFalloSaleor(new Error('algo raro'))).toBe('TRANSITORIO')
    expect(clasificarFalloSaleor(undefined)).toBe('TRANSITORIO')
    expect(clasificarFalloSaleor(null)).toBe('TRANSITORIO')
    expect(clasificarFalloSaleor('un string suelto')).toBe('TRANSITORIO')
  })
})
