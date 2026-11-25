import { describe, it, expect, vi } from 'vitest'
import { sondearUrlPagoAsincrono } from './url-pago-asincrono.js'
import type { WompiTransaction } from './wompi-client.js'

const tx = (extra?: Record<string, unknown>, status: WompiTransaction['status'] = 'PENDING') =>
  ({ id: 't', status, payment_method: extra ? { extra } : undefined }) as unknown as WompiTransaction

function opciones() {
  let t = 0
  return { intervaloMs: 1000, topeMs: 9000, esperar: vi.fn(async (ms: number) => void (t += ms)), ahora: () => t }
}

describe('sondearUrlPagoAsincrono', () => {
  it('obtiene la URL al segundo sondeo', async () => {
    const consultar = vi.fn().mockResolvedValueOnce(tx()).mockResolvedValueOnce(tx({ async_payment_url: 'https://banco.co/x' }))
    const r = await sondearUrlPagoAsincrono(consultar, 't', undefined, opciones())
    expect(r).toEqual({ tipo: 'url', url: 'https://banco.co/x' })
    expect(consultar).toHaveBeenCalledTimes(2)
  })
  it('sin URL al agotar el tope', async () => {
    const consultar = vi.fn().mockResolvedValue(tx())
    const r = await sondearUrlPagoAsincrono(consultar, 't', undefined, opciones())
    expect(r).toEqual({ tipo: 'sinUrl', motivo: 'tiempo' })
    expect(consultar.mock.calls.length).toBeLessThanOrEqual(9)
  })
  it.each(['http://banco.co/x', 'javascript:alert(1)', 'no es url'])('rechaza %s', async (url) => {
    const r = await sondearUrlPagoAsincrono(vi.fn().mockResolvedValue(tx({ async_payment_url: url })), 't', undefined, opciones())
    expect(r).toEqual({ tipo: 'sinUrl', motivo: 'no-https' })
  })
  it('estado final sin URL', async () => {
    const r = await sondearUrlPagoAsincrono(vi.fn().mockResolvedValue(tx(undefined, 'DECLINED')), 't', undefined, opciones())
    expect(r.tipo).toBe('estadoFinal')
  })
  it('error de consulta -> sinUrl sin lanzar', async () => {
    const r = await sondearUrlPagoAsincrono(vi.fn().mockRejectedValue(new Error('x')), 't', undefined, opciones())
    expect(r).toEqual({ tipo: 'sinUrl', motivo: 'error' })
  })
  it('plazo abortado -> sinUrl sin consultar', async () => {
    const c = new AbortController()
    c.abort()
    const consultar = vi.fn()
    expect((await sondearUrlPagoAsincrono(consultar, 't', c.signal, opciones())).tipo).toBe('sinUrl')
    expect(consultar).not.toHaveBeenCalled()
  })
})
