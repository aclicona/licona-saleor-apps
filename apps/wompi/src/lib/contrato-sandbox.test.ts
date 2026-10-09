import { describe, expect, it } from 'vitest'
import {
  combinarResultados,
  evaluarContrato,
  evaluarReferencia,
  motivoLlavesNoSandbox,
  type ObservacionContrato,
  type ObservacionReferencia,
  type ResultadoContrato,
} from './contrato-sandbox.js'
import { WompiHttpError } from './wompi-error.js'

const T1 = '2026-10-09T06:23:16.472Z'
const T2 = '2026-10-09T06:23:20.768Z'
const item = (created_at: string, extra: Record<string, unknown> = {}) => ({
  created_at,
  transaction_id: 'tx',
  status: 'APPROVED',
  amount_in_cents: 1000000,
  ...extra,
})
const get = (created_at: string, httpStatus = 200) => ({ httpStatus, data: { data: { id: 1, ...item(created_at) } } })

const base = (): ObservacionContrato => ({
  refundsEmbebidos: [item(T1), item(T2)],
  refunds: [get(T1), get(T2)],
  listados: [
    { ruta: '/refunds?transaction_id=', httpStatus: 404 },
    { ruta: '/transactions/{id}/refunds', httpStatus: 404 },
  ],
})

describe('evaluarContrato', () => {
  it('verde cuando todo coincide y los listados siguen en 404', () => {
    expect(evaluarContrato(base())).toEqual({ estado: 'verde', causas: [] })
  })

  it('rojo si refunds[] falta', () => {
    const r = evaluarContrato({ ...base(), refundsEmbebidos: undefined })
    expect(r.estado).toBe('rojo')
    expect(r.causas).toContain('refunds_embebido_ausente')
  })

  it.each(['created_at', 'amount_in_cents', 'status'])('rojo si un item embebido no trae %s', (campo) => {
    const roto: Record<string, unknown> = item(T1)
    delete roto[campo]
    const r = evaluarContrato({ ...base(), refundsEmbebidos: [roto, item(T2)] })
    expect(r.estado).toBe('rojo')
    expect(r.causas.join()).toMatch(/embebido_0_sin_/)
  })

  it('rojo si el created_at embebido difiere del de GET /refunds/{id}', () => {
    const r = evaluarContrato({ ...base(), refundsEmbebidos: [item('2026-10-09T06:23:16.473Z'), item(T2)] })
    expect(r.estado).toBe('rojo')
    expect(r.causas.join()).toContain('refund_0_created_at_no_coincide_embebido')
  })

  it('rojo si un created_at no es parseable', () => {
    const r = evaluarContrato({ ...base(), refundsEmbebidos: [item('no-es-fecha'), item(T2)] })
    expect(r.estado).toBe('rojo')
  })

  it('rojo si GET /refunds/{id} no responde 200', () => {
    const r = evaluarContrato({ ...base(), refunds: [get(T1, 404), get(T2)] })
    expect(r.estado).toBe('rojo')
    expect(r.causas.join()).toContain('refund_0_get_sin_created_at_valido(http 404)')
  })

  it('rojo si el importe del embebido difiere', () => {
    const r = evaluarContrato({ ...base(), refundsEmbebidos: [item(T1, { amount_in_cents: 1 }), item(T2)] })
    expect(r.estado).toBe('rojo')
  })

  it('misma instante con distinta precision de texto NO es rojo: la conciliacion compara Date.parse', () => {
    const r = evaluarContrato({ ...base(), refundsEmbebidos: [item('2026-10-09T06:23:16.472000Z'), item(T2)] })
    expect(r).toEqual({ estado: 'verde', causas: [] })
  })

  it('un listado que deja de dar 404 es rojo con causa propia y distinguible', () => {
    const o = base()
    o.listados = [{ ruta: '/refunds?transaction_id=', httpStatus: 200 }, o.listados![1]!]
    const r = evaluarContrato(o)
    expect(r.estado).toBe('rojo')
    expect(r.causas).toEqual(['listado_disponible:/refunds?transaction_id=:200'])
  })

  it('sin_medida cuando no se pudo medir, sin mirar nada mas', () => {
    expect(evaluarContrato({ noMedible: 'tx_no_aprobada' })).toEqual({ estado: 'sin_medida', causas: ['tx_no_aprobada'] })
  })

  it('sin_medida si no hay reembolsos que comparar', () => {
    expect(evaluarContrato({ refundsEmbebidos: [], refunds: [] }).estado).toBe('sin_medida')
  })

  it('sin reembolsos, un listado disponible sigue siendo rojo (no se esconde tras sin_medida)', () => {
    const r = evaluarContrato({ refundsEmbebidos: [], refunds: [], listados: [{ ruta: '/refunds?transaction_id=', httpStatus: 200 }] })
    expect(r).toEqual({ estado: 'rojo', causas: ['listado_disponible:/refunds?transaction_id=:200'] })
  })
})

describe('motivoLlavesNoSandbox', () => {
  it('acepta llaves de sandbox', () => {
    expect(motivoLlavesNoSandbox('prv_test_x', 'pub_test_y')).toBeNull()
  })
  it('rechaza llaves de produccion o ausentes', () => {
    expect(motivoLlavesNoSandbox('prv_prod_x', 'pub_test_y')).toBe('llave_privada_no_sandbox')
    expect(motivoLlavesNoSandbox('prv_test_x', 'pub_prod_y')).toBe('llave_publica_no_sandbox')
    expect(motivoLlavesNoSandbox(undefined, 'pub_test_y')).toBe('llaves_ausentes')
    expect(motivoLlavesNoSandbox('prv_test_x', '')).toBe('llaves_ausentes')
  })
})

const REF = 'b1121-abc12345'
const err422Ref = () =>
  new WompiHttpError('Wompi 422', 422, { error: { type: 'INPUT_VALIDATION_ERROR', messages: { reference: ['ya usada'] } } })

const baseRef = (): ObservacionReferencia => ({
  referencia: REF,
  txId: 'tx-1',
  repeticion: { creada: false, error: err422Ref() },
  busquedaPropia: { cliente: [{ id: 'tx-1', reference: REF }], crudasTotal: 1, crudasAjenas: 0 },
  busquedaInexistente: { cliente: [], crudasTotal: 0, crudasAjenas: 0 },
})

describe('evaluarReferencia (B-1121)', () => {
  it('verde cuando el 422 cumple esReferenciaDuplicada y la busqueda filtra (1 propia, 0 inexistente)', () => {
    expect(evaluarReferencia(baseRef())).toEqual({ estado: 'verde', causas: [] })
  })

  it('rojo si repetir la referencia ya no se rechaza', () => {
    const r = evaluarReferencia({ ...baseRef(), repeticion: { creada: true } })
    expect(r.estado).toBe('rojo')
    expect(r.causas).toContain('repeticion_aceptada')
  })

  it('rojo si el 422 cambia de forma (messages.reference ausente)', () => {
    const otro = new WompiHttpError('x', 422, { error: { type: 'INPUT_VALIDATION_ERROR', messages: { signature: ['mal'] } } })
    const r = evaluarReferencia({ ...baseRef(), repeticion: { creada: false, error: otro } })
    expect(r.estado).toBe('rojo')
    expect(r.causas).toContain('repeticion_no_es_referencia_duplicada')
  })

  it('rojo si la repeticion falla con otro status', () => {
    const r = evaluarReferencia({ ...baseRef(), repeticion: { creada: false, error: new WompiHttpError('x', 400, {}) } })
    expect(r.causas).toContain('repeticion_no_es_referencia_duplicada')
  })

  it.each([0, 2])('rojo si la busqueda propia devuelve %i filas', (n) => {
    const cliente = Array.from({ length: n }, () => ({ id: 'tx-1', reference: REF }))
    const r = evaluarReferencia({ ...baseRef(), busquedaPropia: { cliente, crudasTotal: n, crudasAjenas: 0 } })
    expect(r.estado).toBe('rojo')
    expect(r.causas).toContain(`busqueda_propia_n=${n}`)
  })

  it('rojo si la busqueda propia devuelve un id ajeno', () => {
    const r = evaluarReferencia({
      ...baseRef(),
      busquedaPropia: { cliente: [{ id: 'otra', reference: REF }], crudasTotal: 1, crudasAjenas: 0 },
    })
    expect(r.causas).toContain('busqueda_propia_id_ajeno')
  })

  it('rojo si Wompi ignora el filtro: la respuesta cruda trae filas de otras referencias (el refiltro lo taparia)', () => {
    const r = evaluarReferencia({
      ...baseRef(),
      busquedaPropia: { cliente: [{ id: 'tx-1', reference: REF }], crudasTotal: 20, crudasAjenas: 19 },
    })
    expect(r.estado).toBe('rojo')
    expect(r.causas).toContain('busqueda_propia_filtro_ignorado(crudas 20, ajenas 19)')
  })

  it('rojo si la busqueda de una referencia inexistente devuelve algo', () => {
    const r = evaluarReferencia({
      ...baseRef(),
      busquedaInexistente: { cliente: [], crudasTotal: 20, crudasAjenas: 20 },
    })
    expect(r.estado).toBe('rojo')
    expect(r.causas).toContain('busqueda_inexistente_filtro_ignorado(crudas 20, ajenas 20)')
  })

  it('rojo si la inexistente devuelve filas tras el refiltro', () => {
    const r = evaluarReferencia({
      ...baseRef(),
      busquedaInexistente: { cliente: [{ id: 'x', reference: 'q' }], crudasTotal: 1, crudasAjenas: 0 },
    })
    expect(r.causas).toContain('busqueda_inexistente_n=1')
  })

  it('sin_medida si no se pudo medir', () => {
    expect(evaluarReferencia({ noMedible: 'tx_no_creada(http 500)' })).toEqual({
      estado: 'sin_medida',
      causas: ['tx_no_creada(http 500)'],
    })
  })
})

describe('combinarResultados', () => {
  const v: ResultadoContrato = { estado: 'verde', causas: [] }
  const rojo: ResultadoContrato = { estado: 'rojo', causas: ['a'] }
  const sm: ResultadoContrato = { estado: 'sin_medida', causas: ['b'] }
  it('verde solo si todos son verdes', () => {
    expect(combinarResultados([v, v])).toEqual({ estado: 'verde', causas: [] })
  })
  it('rojo gana a sin_medida y junta causas', () => {
    expect(combinarResultados([sm, rojo])).toEqual({ estado: 'rojo', causas: ['a'] })
  })
  it('sin_medida si no hay rojo pero algo no se midio', () => {
    expect(combinarResultados([v, sm])).toEqual({ estado: 'sin_medida', causas: ['b'] })
  })
})
