import { describe, it, expect } from 'vitest'
import {
  VARIABLES_DE_OPERACION,
  VARIABLES_OBLIGATORIAS,
  VARIABLES_OPCIONALES,
  appRegistrada,
  mensajeModoDegradado,
  validarConfiguracion,
  variablesDeOperacionFaltantes,
  variablesObligatoriasFaltantes,
} from './config.js'

/**
 * Entorno con todas las variables presentes y no vacías: las bloqueantes del
 * arranque y las de operación. Es el estado de una instancia ya aprovisionada
 * y registrada.
 */
function entornoCompleto(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const { nombre } of [...VARIABLES_OBLIGATORIAS, ...VARIABLES_DE_OPERACION]) {
    env[nombre] = `valor-de-prueba-${nombre.toLowerCase()}`
  }
  return env
}

describe('validarConfiguracion — fail-fast de variables obligatorias', () => {
  it('pasa sin lanzar cuando están todas las variables obligatorias', () => {
    expect(() => validarConfiguracion(entornoCompleto())).not.toThrow()
  })

  it('falla cuando falta WOMPI_EVENTS_SECRET y el mensaje nombra la variable', () => {
    // Es EL caso que motiva todo el fail-fast: sin este secreto la App
    // levantaba y aceptaba confirmaciones de pago anónimas.
    const env = entornoCompleto()
    delete env.WOMPI_EVENTS_SECRET

    expect(() => validarConfiguracion(env)).toThrow(/WOMPI_EVENTS_SECRET/)
  })

  it('trata una variable obligatoria presente pero vacía como ausente', () => {
    // `WOMPI_EVENTS_SECRET=` en el .env producía exactamente el agujero que
    // abría el viejo `if (secret && ...)`: la variable existe, pero no sirve.
    const env = entornoCompleto()
    env.WOMPI_EVENTS_SECRET = ''

    expect(() => validarConfiguracion(env)).toThrow(/WOMPI_EVENTS_SECRET/)
  })

  it('trata una variable obligatoria con solo espacios como ausente', () => {
    const env = entornoCompleto()
    env.WOMPI_PRIVATE_KEY = '   '

    expect(() => validarConfiguracion(env)).toThrow(/WOMPI_PRIVATE_KEY/)
  })

  it('falla si falta cualquiera de las variables obligatorias, una por una', () => {
    for (const { nombre } of VARIABLES_OBLIGATORIAS) {
      const env = entornoCompleto()
      delete env[nombre]

      expect(() => validarConfiguracion(env), `debería fallar sin ${nombre}`).toThrow(new RegExp(nombre))
    }
  })

  it('nombra TODAS las variables que faltan, no solo la primera', () => {
    // Quien aprovisiona una instancia nueva tiene que poder arreglar el .env
    // de una pasada, no descubrir las variables de a una por deploy fallido.
    const env: NodeJS.ProcessEnv = {}

    let mensaje = ''
    try {
      validarConfiguracion(env)
    } catch (error) {
      mensaje = (error as Error).message
    }

    for (const { nombre } of VARIABLES_OBLIGATORIAS) {
      expect(mensaje).toContain(nombre)
    }
  })

  it('no exige ninguna variable opcional', () => {
    // Las opcionales tienen default; su ausencia no puede cobrar de más ni
    // aceptar pagos falsos, que es el criterio que las separa.
    const env = entornoCompleto()
    for (const { nombre } of VARIABLES_OPCIONALES) {
      delete env[nombre]
    }

    expect(() => validarConfiguracion(env)).not.toThrow()
  })

  it('las tres listas de variables son disjuntas', () => {
    // Una variable en dos clases a la vez es una contradicción sobre qué pasa
    // si falta: no puede a la vez abortar el arranque y degradarlo.
    const nombres = [
      ...VARIABLES_OBLIGATORIAS.map((v) => v.nombre),
      ...VARIABLES_DE_OPERACION.map((v) => v.nombre),
      ...VARIABLES_OPCIONALES.map((v) => v.nombre),
    ]

    expect(new Set(nombres).size, `hay nombres repetidos entre listas: ${nombres.join(', ')}`).toBe(nombres.length)
  })
})

describe('SALEOR_APP_TOKEN — requisito de operación, no de arranque', () => {
  // El candado que estos tests impiden que vuelva: con el token como
  // bloqueante, la App no arranca sin token y Saleor no puede darle el token
  // sin que arranque, así que NO se puede aprovisionar una instancia nueva.
  it('no está entre las variables que bloquean el arranque', () => {
    const bloqueantes = VARIABLES_OBLIGATORIAS.map((v) => v.nombre)

    expect(bloqueantes).not.toContain('SALEOR_APP_TOKEN')
  })

  it('está declarado como variable de operación', () => {
    expect(VARIABLES_DE_OPERACION.map((v) => v.nombre)).toContain('SALEOR_APP_TOKEN')
  })

  it('sin SALEOR_APP_TOKEN la configuración NO lanza: la App arranca degradada', () => {
    const env = entornoCompleto()
    delete env.SALEOR_APP_TOKEN

    expect(() => validarConfiguracion(env)).not.toThrow()
  })

  it('sin SALEOR_APP_TOKEN la App no se considera registrada', () => {
    const env = entornoCompleto()
    delete env.SALEOR_APP_TOKEN

    expect(appRegistrada(env)).toBe(false)
    expect(variablesDeOperacionFaltantes(env)).toEqual(['SALEOR_APP_TOKEN'])
  })

  it('un SALEOR_APP_TOKEN vacío o con espacios tampoco cuenta como registrada', () => {
    // `SALEOR_APP_TOKEN=` en el .env es el error típico de aprovisionamiento:
    // la variable existe, pero no autentica nada.
    for (const valor of ['', '   ']) {
      const env = entornoCompleto()
      env.SALEOR_APP_TOKEN = valor

      expect(appRegistrada(env), `"${valor}" debería contar como ausente`).toBe(false)
    }
  })

  it('con el entorno completo la App se considera registrada', () => {
    expect(appRegistrada(entornoCompleto())).toBe(true)
    expect(variablesDeOperacionFaltantes(entornoCompleto())).toEqual([])
  })

  it('WOMPI_EVENTS_SECRET NO se degradó: sigue bloqueando el arranque', () => {
    // La distinción entera depende de esto. El secreto de eventos es una
    // credencial de ENTRADA: sin ella la App no se queda corta, opera MAL,
    // aceptando confirmaciones de pago anónimas. Un 503 no arregla eso.
    const env = entornoCompleto()
    delete env.WOMPI_EVENTS_SECRET

    expect(() => validarConfiguracion(env)).toThrow(/WOMPI_EVENTS_SECRET/)
    expect(VARIABLES_DE_OPERACION.map((v) => v.nombre)).not.toContain('WOMPI_EVENTS_SECRET')
  })
})

describe('mensajeModoDegradado', () => {
  it('devuelve null cuando la App está registrada', () => {
    expect(mensajeModoDegradado(entornoCompleto())).toBeNull()
  })

  it('nombra la variable que falta y avisa de que la App no está operativa', () => {
    const env = entornoCompleto()
    delete env.SALEOR_APP_TOKEN

    const mensaje = mensajeModoDegradado(env)

    expect(mensaje).toContain('SALEOR_APP_TOKEN')
    expect(mensaje).toContain('MODO DEGRADADO')
    expect(mensaje).toContain('503')
  })
})

describe('variablesObligatoriasFaltantes', () => {
  it('devuelve una lista vacía cuando el entorno está completo', () => {
    expect(variablesObligatoriasFaltantes(entornoCompleto())).toEqual([])
  })

  it('devuelve exactamente las que faltan', () => {
    const env = entornoCompleto()
    delete env.WOMPI_EVENTS_SECRET
    delete env.WOMPI_INTEGRITY_KEY

    expect(variablesObligatoriasFaltantes(env).sort()).toEqual(['WOMPI_EVENTS_SECRET', 'WOMPI_INTEGRITY_KEY'])
  })
})
