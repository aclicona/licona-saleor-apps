import Fastify from 'fastify'
import { describe, it, expect } from 'vitest'
import {
  CENSURA,
  NIVELES_VALIDOS,
  NIVEL_POR_DEFECTO,
  avisoNivelLogInvalido,
  nivelLog,
  opcionesLogger,
  opcionesServidor,
} from './logging.js'

/**
 * Estos tests no leen la configuración: la EJECUTAN. `redact` se comprueba
 * mirando los bytes que salen por el stream del logger, porque una lista de
 * rutas mal escrita (un comodín donde pino no lo admite, una ruta que el
 * serializer de Fastify ya se comió) es exactamente el fallo que "se ve bien"
 * en el código y no protege nada en ejecución.
 */

const TOKEN = 'TOKEN-QUE-NO-DEBE-APARECER-EN-EL-LOG'

/** Logger real con las opciones reales, escribiendo a un buffer en memoria. */
function loggerDePrueba(env: NodeJS.ProcessEnv = {}) {
  const lineas: string[] = []
  const app = Fastify({
    logger: { ...opcionesLogger(env), stream: { write: (linea: string) => void lineas.push(linea) } },
  })
  return { log: app.log, lineas, salida: () => lineas.join('') }
}

describe('nivel de log configurable por entorno', () => {
  it('usa info por defecto: en pagos el camino feliz también es evidencia', () => {
    expect(nivelLog({})).toBe('info')
    expect(NIVEL_POR_DEFECTO).toBe('info')
  })

  it.each(NIVELES_VALIDOS)('respeta LOG_LEVEL=%s', (nivel) => {
    expect(nivelLog({ LOG_LEVEL: nivel })).toBe(nivel)
  })

  it('normaliza mayúsculas y espacios', () => {
    expect(nivelLog({ LOG_LEVEL: '  DEBUG ' })).toBe('debug')
  })

  it('un LOG_LEVEL inválido cae al default en vez de tumbar el proceso', () => {
    // pino LANZA al construirse con un nivel desconocido. Una App de pagos
    // caída por una errata en la verbosidad del log es peor que la errata.
    expect(nivelLog({ LOG_LEVEL: 'verboso' })).toBe(NIVEL_POR_DEFECTO)
    expect(() => loggerDePrueba({ LOG_LEVEL: 'verboso' })).not.toThrow()
  })

  it('pero lo avisa: no se traga la errata en silencio', () => {
    expect(avisoNivelLogInvalido({ LOG_LEVEL: 'verboso' })).toContain('verboso')
    expect(avisoNivelLogInvalido({ LOG_LEVEL: 'debug' })).toBeNull()
    expect(avisoNivelLogInvalido({})).toBeNull()
  })

  it('el nivel filtra de verdad', () => {
    const { log, salida } = loggerDePrueba({ LOG_LEVEL: 'warn' })
    log.info('esto no debería salir')
    log.warn('esto sí')

    expect(salida()).not.toContain('esto no debería salir')
    expect(salida()).toContain('esto sí')
  })
})

describe('redact — la credencial no llega al log', () => {
  it.each([
    ['token en la raíz', { token: TOKEN }],
    ['auth_token en la raíz (el campo que manda Saleor)', { auth_token: TOKEN }],
    ['authToken en la raíz', { authToken: TOKEN }],
    ['secret en la raíz', { secret: TOKEN }],
    ['password en la raíz', { password: TOKEN }],
    ['privateKey en la raíz', { privateKey: TOKEN }],
    ['acceptance_token (Wompi)', { acceptance_token: TOKEN }],
    ['token anidado un nivel', { contexto: { token: TOKEN } }],
    ['secret anidado un nivel', { error: { secret: TOKEN } }],
    ['authorization en la raíz', { authorization: `Bearer ${TOKEN}` }],
    ['cabeceras logueadas a mano', { headers: { authorization: `Bearer ${TOKEN}` } }],
    ['firma de Saleor en cabeceras', { headers: { 'saleor-signature': TOKEN } }],
    ['cabeceras anidadas un nivel', { peticion: { headers: { authorization: `Bearer ${TOKEN}` } } }],
  ])('censura %s', (_titulo, contexto) => {
    const { log, salida } = loggerDePrueba()
    log.info(contexto, 'mensaje')

    expect(salida()).not.toContain(TOKEN)
    expect(salida()).toContain(CENSURA)
  })

  it('no toca los campos de correlación: censurar de más ciega igual que filtrar', () => {
    const { log, salida } = loggerDePrueba()
    log.info({ checkoutId: 'Q2hlY2tvdXQ6MQ==', transactionId: 'VHJhbnNhY3Rpb246MQ==', pspReference: 'wompi-txn-12345' }, 'ok')

    expect(salida()).toContain('Q2hlY2tvdXQ6MQ==')
    expect(salida()).toContain('VHJhbnNhY3Rpb246MQ==')
    expect(salida()).toContain('wompi-txn-12345')
    expect(salida()).not.toContain(CENSURA)
  })

  it('la lista de rutas es válida para pino: construir el logger no lanza', () => {
    // Una ruta mal formada hace que pino lance AL CONSTRUIRSE, es decir, la App
    // no arrancaría. Se comprueba aquí para que el fallo salga en el test y no
    // en el primer despliegue.
    expect(() => loggerDePrueba()).not.toThrow()
  })
})

describe('genReqId — identificador del salto local', () => {
  it('genera un id distinto por petición', () => {
    const { genReqId } = opcionesServidor()

    expect(genReqId()).not.toBe(genReqId())
  })

  it('no se acepta del exterior: requestIdHeader se deja desactivado', () => {
    // Fastify 5 trae `requestIdHeader: false` por defecto. Se comprueba que
    // NO lo estamos reactivando: un id que controla el llamante puede colisionar
    // a propósito y deja de identificar nada. La correlación entre servicios la
    // hacen las claves de dominio, que son verificables contra Saleor.
    expect(opcionesServidor()).not.toHaveProperty('requestIdHeader')
  })
})
