import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi } from 'vitest'
import { manejadorRegistro } from './registro.js'
import { opcionesLogger } from './logging.js'

/**
 * El handler de `/api/register` escribía el token de la App ENTERO en el log:
 *
 *   app.log.info({ msg: 'App registered — copy token to .env', token: auth_token })
 *
 * Un token en un log retenido es una credencial válida a la vista de cualquiera
 * con acceso de lectura al panel de despliegue. Estos tests capturan lo que se
 * escribe de verdad, no lo que dice el código.
 */

const TOKEN = 'token-de-app-de-saleor-que-no-debe-aparecer-en-el-log'

/** Doble de FastifyRequest con logger espiable. */
function crearRequest(extra: Partial<FastifyRequest> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() }
  const req = { url: '/api/register', method: 'POST', headers: {}, log, ...extra }
  return { req: req as unknown as FastifyRequest, log }
}

/** Doble de FastifyReply que registra status y cuerpo. */
function crearReply() {
  const estado = { status: 200 as number, body: undefined as unknown }
  const reply = {
    status(codigo: number) {
      estado.status = codigo
      return this
    },
    send(cuerpo: unknown) {
      estado.body = cuerpo
      return this
    },
  }
  return { reply: reply as unknown as FastifyReply, estado }
}

describe('POST /api/register — no escribe el token en el log', () => {
  it('el valor del token NO aparece en ninguna llamada al logger', async () => {
    const { req, log } = crearRequest({ body: { auth_token: TOKEN } } as Partial<FastifyRequest>)
    const { reply } = crearReply()

    await manejadorRegistro(req, reply)

    const todoLoRegistrado = JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
      log.debug.mock.calls,
      log.fatal.mock.calls,
    ])
    expect(todoLoRegistrado).not.toContain(TOKEN)
  })

  it('tampoco sale por el logger REAL de la App, con redact incluido', async () => {
    // Doble red: aunque alguien reintrodujera el `token:` en el contexto,
    // `redact` lo censura antes de escribir.
    const lineas: string[] = []
    const app = Fastify({
      logger: { ...opcionesLogger({}), stream: { write: (linea: string) => void lineas.push(linea) } },
    })
    app.post('/api/register', manejadorRegistro)

    const respuesta = await app.inject({ method: 'POST', url: '/api/register', payload: { auth_token: TOKEN } })

    expect(respuesta.statusCode).toBe(200)
    expect(lineas.join('')).not.toContain(TOKEN)
    await app.close()
  })

  it('no se pierde diagnóstico: consta el origen y la longitud del token', async () => {
    // Sigue sirviendo para responder "¿me llegó el token?" y "¿de qué Saleor?"
    // sin dejar la credencial escrita.
    const { req, log } = crearRequest({
      body: { auth_token: TOKEN },
      headers: { 'saleor-domain': 'tienda.example.com', 'saleor-api-url': 'https://tienda.example.com/graphql/' },
    } as Partial<FastifyRequest>)
    const { reply } = crearReply()

    await manejadorRegistro(req, reply)

    expect(log.info).toHaveBeenCalledOnce()
    const [contexto] = log.info.mock.calls[0] as [Record<string, unknown>]
    expect(contexto.dominioSaleor).toBe('tienda.example.com')
    expect(contexto.apiUrlSaleor).toBe('https://tienda.example.com/graphql/')
    expect(contexto.longitudToken).toBe(TOKEN.length)
  })

  it('responde 200: si esta respuesta falla, Saleor borra la App entera', async () => {
    // Verificado en el fork: saleor/app/installation_utils.py:302-306 hace
    // app.delete() y revierte la instalación si el POST del token falla.
    const { req } = crearRequest({ body: { auth_token: TOKEN } } as Partial<FastifyRequest>)
    const { reply, estado } = crearReply()

    await manejadorRegistro(req, reply)

    expect(estado.status).toBe(200)
    expect(estado.body).toEqual({ success: true })
  })

  it('responde 400 si el cuerpo no trae auth_token', async () => {
    const { req } = crearRequest({ body: {} } as Partial<FastifyRequest>)
    const { reply, estado } = crearReply()

    await manejadorRegistro(req, reply)

    expect(estado.status).toBe(400)
  })
})
