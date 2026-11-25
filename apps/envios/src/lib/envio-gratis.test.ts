import { describe, it, expect } from 'vitest'
import {
  ENVIO_GRATIS_ID,
  HORIZONTE_MAXIMO_MS,
  conEnvioGratis,
  envioGratisVigente,
} from './envio-gratis.js'
import { cotizarEnvios } from './tarifas.js'

const AHORA = new Date('2026-11-26T12:00:00-05:00')

describe('envioGratisVigente — decide si el método temporal se ofrece', () => {
  it('no vigente sin variable (undefined) y sin motivo: es el caso normal', () => {
    expect(envioGratisVigente(undefined, AHORA)).toEqual({ vigente: false })
  })

  it('no vigente con cadena vacía o solo espacios, sin motivo', () => {
    expect(envioGratisVigente('', AHORA)).toEqual({ vigente: false })
    expect(envioGratisVigente('   ', AHORA)).toEqual({ vigente: false })
  })

  it('no vigente con fecha inválida, con motivo', () => {
    const r = envioGratisVigente('mañana', AHORA)
    expect(r.vigente).toBe(false)
    expect(r.motivo).toMatch(/inválid/i)
  })

  it('no vigente si la fecha no trae zona horaria (ambigua)', () => {
    const r = envioGratisVigente('2026-11-27T06:00:00', AHORA)
    expect(r.vigente).toBe(false)
    expect(r.motivo).toMatch(/zona/i)
  })

  it('no vigente si ya venció, con motivo', () => {
    const r = envioGratisVigente('2026-11-26T11:59:59-05:00', AHORA)
    expect(r.vigente).toBe(false)
    expect(r.motivo).toMatch(/venci/i)
  })

  it('vigente si caduca en el futuro dentro del horizonte', () => {
    const r = envioGratisVigente('2026-11-27T06:00:00-05:00', AHORA)
    expect(r.vigente).toBe(true)
    expect(r.hasta?.toISOString()).toBe('2026-11-27T11:00:00.000Z')
  })

  it('no vigente exactamente en el instante de caducidad (ahora < hasta es estricto)', () => {
    const r = envioGratisVigente('2026-11-26T12:00:00-05:00', AHORA)
    expect(r.vigente).toBe(false)
  })

  it('vigente exactamente en el límite del horizonte de 72 h', () => {
    const limite = new Date(AHORA.getTime() + HORIZONTE_MAXIMO_MS).toISOString()
    expect(envioGratisVigente(limite, AHORA).vigente).toBe(true)
  })

  it('no vigente un milisegundo más allá de las 72 h, con motivo', () => {
    const pasado = new Date(AHORA.getTime() + HORIZONTE_MAXIMO_MS + 1).toISOString()
    const r = envioGratisVigente(pasado, AHORA)
    expect(r.vigente).toBe(false)
    expect(r.motivo).toMatch(/72/)
  })

  it('interpreta bien la zona -05:00: 06:00-05:00 equivale a 11:00Z', () => {
    const antes = new Date('2026-11-27T10:59:59Z')
    const despues = new Date('2026-11-27T11:00:00Z')
    expect(envioGratisVigente('2026-11-27T06:00:00-05:00', antes).vigente).toBe(true)
    expect(envioGratisVigente('2026-11-27T06:00:00-05:00', despues).vigente).toBe(false)
  })
})

describe('conEnvioGratis — inyección del método', () => {
  const base = cotizarEnvios(1)

  it('pone el método gratis primero y deja los tres actuales intactos', () => {
    const r = conEnvioGratis(base)
    expect(r).toHaveLength(4)
    expect(r[0]).toEqual({
      id: ENVIO_GRATIS_ID,
      name: 'Envío gratis (temporal)',
      amount: 0,
      currency: 'COP',
      minimumDeliveryDays: 3,
      maximumDeliveryDays: 5,
    })
    expect(r.slice(1)).toEqual(base)
  })

  it('no muta el arreglo de entrada', () => {
    const copia = [...base]
    conEnvioGratis(base)
    expect(base).toEqual(copia)
    expect(base).toHaveLength(3)
  })
})
