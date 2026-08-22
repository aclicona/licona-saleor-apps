import { describe, it, expect } from 'vitest'
import {
  VARIABLES_OBLIGATORIAS,
  VARIABLES_OPCIONALES,
  validarConfiguracion,
  variablesObligatoriasFaltantes,
} from './config.js'

/** Entorno con todas las variables obligatorias presentes y no vacías. */
function entornoCompleto(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const { nombre } of VARIABLES_OBLIGATORIAS) {
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
    env.SALEOR_APP_TOKEN = '   '

    expect(() => validarConfiguracion(env)).toThrow(/SALEOR_APP_TOKEN/)
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

  it('las listas de obligatorias y opcionales no se solapan', () => {
    const opcionales = new Set(VARIABLES_OPCIONALES.map((v) => v.nombre))
    for (const { nombre } of VARIABLES_OBLIGATORIAS) {
      expect(opcionales.has(nombre), `${nombre} está en las dos listas`).toBe(false)
    }
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
