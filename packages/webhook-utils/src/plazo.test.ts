import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { crearPlazo, PLAZO_WEBHOOK_SINCRONO_MS, webhooksSincronos } from './plazo.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('crearPlazo', () => {
  it('por defecto dura 15 s, bajo los 18 s de Saleor', () => {
    expect(PLAZO_WEBHOOK_SINCRONO_MS).toBe(15_000)
    expect(crearPlazo().restanteMs()).toBe(15_000)
  })

  it('cuenta desde la creación, no desde el primer acceso a la señal', () => {
    const plazo = crearPlazo(15_000)
    vi.advanceTimersByTime(5_000)
    expect(plazo.restanteMs()).toBe(10_000)
    const { signal } = plazo
    vi.advanceTimersByTime(9_999)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.aborted).toBe(true)
    plazo.limpiar()
  })

  it('si ya se agotó antes del primer acceso, la señal nace abortada', () => {
    const plazo = crearPlazo(1_000)
    vi.advanceTimersByTime(2_000)
    expect(plazo.restanteMs()).toBe(-1_000)
    expect(plazo.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('el motivo viaja en signal.reason', () => {
    const plazo = crearPlazo(10, 'Plazo del reembolso agotado')
    const { signal } = plazo
    vi.advanceTimersByTime(10)
    expect((signal.reason as Error).message).toBe('Plazo del reembolso agotado')
  })

  it('limpiar cancela el temporizador y no deja nada pendiente', () => {
    const plazo = crearPlazo(10)
    const { signal } = plazo
    plazo.limpiar()
    plazo.limpiar()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(100)
    expect(signal.aborted).toBe(false)
  })

  it('sin leer la señal no crea ningún temporizador', () => {
    const plazo = crearPlazo()
    plazo.limpiar()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('webhooksSincronos', () => {
  it('devuelve solo los que tienen syncEvents, con la ruta del targetUrl', () => {
    const r = webhooksSincronos([
      { name: 'a', targetUrl: 'https://x.test/api/webhooks/a', syncEvents: ['E_A'] },
      { name: 'b', targetUrl: 'https://x.test/api/webhooks/b' },
      { name: 'c', targetUrl: 'https://x.test/api/webhooks/c', syncEvents: [] },
    ])
    expect(r).toEqual([{ name: 'a', ruta: '/api/webhooks/a', eventos: ['E_A'] }])
  })
})
