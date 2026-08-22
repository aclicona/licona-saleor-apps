import Fastify from 'fastify'
import { describe, it, expect } from 'vitest'
import { CENSURA, NIVELES_VALIDOS, NIVEL_POR_DEFECTO, avisoNivelLogInvalido, nivelLog, opcionesLogger, opcionesServidor } from './logging.js'

/** Gemelo de apps/wompi/src/lib/logging.test.ts: mismas garantías, misma App distinta. */

const TOKEN = 'TOKEN-QUE-NO-DEBE-APARECER-EN-EL-LOG'

function loggerDePrueba(env: NodeJS.ProcessEnv = {}) {
  const lineas: string[] = []
  const app = Fastify({
    logger: { ...opcionesLogger(env), stream: { write: (linea: string) => void lineas.push(linea) } },
  })
  return { log: app.log, salida: () => lineas.join('') }
}

describe('nivel de log configurable por entorno', () => {
  it('usa info por defecto', () => {
    expect(nivelLog({})).toBe(NIVEL_POR_DEFECTO)
  })

  it.each(NIVELES_VALIDOS)('respeta LOG_LEVEL=%s', (nivel) => {
    expect(nivelLog({ LOG_LEVEL: nivel })).toBe(nivel)
  })

  it('un LOG_LEVEL inválido cae al default y se avisa, en vez de tumbar el proceso', () => {
    expect(nivelLog({ LOG_LEVEL: 'verboso' })).toBe(NIVEL_POR_DEFECTO)
    expect(() => loggerDePrueba({ LOG_LEVEL: 'verboso' })).not.toThrow()
    expect(avisoNivelLogInvalido({ LOG_LEVEL: 'verboso' })).toContain('verboso')
    expect(avisoNivelLogInvalido({})).toBeNull()
  })
})

describe('redact — la credencial no llega al log', () => {
  it.each([
    ['token en la raíz', { token: TOKEN }],
    ['auth_token en la raíz (el campo que manda Saleor)', { auth_token: TOKEN }],
    ['secret en la raíz', { secret: TOKEN }],
    ['token anidado un nivel', { contexto: { token: TOKEN } }],
    ['cabeceras logueadas a mano', { headers: { authorization: `Bearer ${TOKEN}` } }],
    ['firma de Saleor en cabeceras', { headers: { 'saleor-signature': TOKEN } }],
  ])('censura %s', (_titulo, contexto) => {
    const { log, salida } = loggerDePrueba()
    log.info(contexto, 'mensaje')

    expect(salida()).not.toContain(TOKEN)
    expect(salida()).toContain(CENSURA)
  })

  it('la lista de rutas es válida para pino: construir el logger no lanza', () => {
    expect(() => loggerDePrueba()).not.toThrow()
  })
})

describe('genReqId', () => {
  it('genera un id distinto por petición y no se acepta del exterior', () => {
    const { genReqId } = opcionesServidor()
    expect(genReqId()).not.toBe(genReqId())
    expect(opcionesServidor()).not.toHaveProperty('requestIdHeader')
  })
})
