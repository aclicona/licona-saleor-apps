import { describe, it, expect } from 'vitest'
import { traducirUserTypePse } from './pse-user-type.js'

describe('traducirUserTypePse', () => {
  it.each([
    [undefined, 0],
    ['PERSON', 0],
    ['COMPANY', 1],
    [0, 0],
    [1, 1],
    ['0', 0],
    ['1', 1],
  ])('%j -> %j', (entrada, esperado) => {
    expect(traducirUserTypePse(entrada)).toEqual({ ok: true, userType: esperado })
  })

  it.each([['OTRO'], [2], ['2'], [-1], [1.5], [null], [true], [{}], ['person'], ['']])('rechaza %j', (entrada) => {
    const r = traducirUserTypePse(entrada)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/tipo de persona/i)
  })
})
