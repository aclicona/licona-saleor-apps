import Fastify from 'fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { paymentGatewayInitializeHandler } from '../webhooks/payment-gateway-initialize.js'
import { wompiIncomingHandler } from '../webhooks/wompi-incoming.js'
import { MENSAJE_NO_REGISTRADA, exigirAppRegistrada, manejadorRegistro, manejadorSalud } from './registro.js'

/**
 * Estos tests son sobre el CANDADO DE ARRANQUE: una instancia nueva no se podía
 * aprovisionar porque `SALEOR_APP_TOKEN` bloqueaba el arranque, y ese token solo
 * existe después de que Saleor instale la App — lo que exige la App viva.
 *
 * Lo que se fija aquí es el contrato del modo degradado: qué se sirve sin token,
 * qué se rechaza y con qué código.
 */

const TOKEN_DE_PRUEBA = 'token-de-app-de-saleor-que-no-debe-aparecer-en-el-log'

/** Los tests manipulan `process.env`; se restaura entero al terminar. */
const entornoOriginal = { ...process.env }

beforeEach(() => {
  process.env.SALEOR_APP_TOKEN = TOKEN_DE_PRUEBA
})

afterEach(() => {
  process.env = { ...entornoOriginal }
  vi.restoreAllMocks()
})

/** Doble de FastifyRequest con logger espiable. */
function crearRequest(extra: Partial<FastifyRequest> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() }
  const req = { url: '/api/webhooks/transaction-initialize-session', method: 'POST', headers: {}, log, ...extra }
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

/**
 * Servidor mínimo que replica el cableado de `index.ts` para las rutas que
 * exigen registro. Se usan los handlers REALES a propósito: si la guardia no
 * cortara, `paymentGatewayInitializeHandler` intentaría verificar el JWS contra
 * Saleor y el test fallaría con un 401/500 — es decir, un 503 aquí prueba que
 * la guardia corta ANTES de tocar nada.
 */
function servidorConGuardia() {
  const app = Fastify({ logger: false })
  const soloRegistrada = { preHandler: exigirAppRegistrada }
  app.post('/api/webhooks/payment-gateway-initialize-session', soloRegistrada, paymentGatewayInitializeHandler)
  app.post('/api/webhooks/wompi-incoming', soloRegistrada, wompiIncomingHandler)
  app.get('/api/health', manejadorSalud)
  return app
}

describe('healthcheck — dice si la App está registrada, no solo si responde', () => {
  it('reporta registered: false y status degraded sin SALEOR_APP_TOKEN', async () => {
    // Un healthcheck que solo dijera "el proceso responde" se pondría verde
    // sobre una App incapaz de procesar un solo pago.
    delete process.env.SALEOR_APP_TOKEN

    expect(await manejadorSalud()).toEqual({ status: 'degraded', registered: false })
  })

  it('reporta registered: true y status ok con el token puesto', async () => {
    expect(await manejadorSalud()).toEqual({ status: 'ok', registered: true })
  })

  it('responde 200 incluso degradado: un 503 aquí reabriría el candado', async () => {
    // Si el orquestador matara el contenedor por no estar registrado, la App
    // nunca llegaría viva al POST del token y la instalación sería imposible.
    delete process.env.SALEOR_APP_TOKEN
    const app = servidorConGuardia()

    const respuesta = await app.inject({ method: 'GET', url: '/api/health' })

    expect(respuesta.statusCode).toBe(200)
    expect(respuesta.json()).toEqual({ status: 'degraded', registered: false })
    await app.close()
  })

  it('no hace ninguna llamada de red', async () => {
    // El healthcheck se invoca constantemente; una llamada de red aquí
    // convertiría el monitoreo en carga y ataría la salud de la App a la de
    // Saleor, que es justo lo que NO debe medir.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await manejadorSalud()
    delete process.env.SALEOR_APP_TOKEN
    await manejadorSalud()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('exigirAppRegistrada — 503 en los endpoints que hablan con Saleor', () => {
  it('deja pasar cuando la App está registrada', async () => {
    const { req } = crearRequest()
    const { reply, estado } = crearReply()

    await exigirAppRegistrada(req, reply)

    expect(estado.status).toBe(200) // sin tocar: la guardia no respondió
    expect(estado.body).toBeUndefined()
  })

  it('responde 503 con mensaje explícito cuando falta el token', async () => {
    delete process.env.SALEOR_APP_TOKEN
    const { req } = crearRequest()
    const { reply, estado } = crearReply()

    await exigirAppRegistrada(req, reply)

    expect(estado.status).toBe(503)
    expect(estado.body).toEqual({ error: MENSAJE_NO_REGISTRADA })
    expect(MENSAJE_NO_REGISTRADA).toContain('SALEOR_APP_TOKEN')
  })

  it('deja rastro en el log de por qué rechazó', async () => {
    delete process.env.SALEOR_APP_TOKEN
    const { req, log } = crearRequest()
    const { reply } = crearReply()

    await exigirAppRegistrada(req, reply)

    expect(log.error).toHaveBeenCalledOnce()
    expect(JSON.stringify(log.error.mock.calls[0])).toContain('SALEOR_APP_TOKEN')
  })

  it('un webhook de pago responde 503 —no 500 ni 200— sin el token', async () => {
    // 500 diría "bug de la App" y mandaría a alguien a buscar un stack trace
    // inexistente; 200 mentiría. 503 es "vuelve a intentarlo", que es la verdad.
    delete process.env.SALEOR_APP_TOKEN
    const app = servidorConGuardia()

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/webhooks/payment-gateway-initialize-session',
      payload: {},
    })

    expect(respuesta.statusCode).toBe(503)
    expect(respuesta.json()).toEqual({ error: MENSAJE_NO_REGISTRADA })
    await app.close()
  })

  it('el webhook entrante de Wompi también responde 503 sin el token', async () => {
    // Aquí un 200 sería lo peor posible: Wompi daría el evento por entregado y
    // no reintentaría, perdiendo para siempre la confirmación de un pago real.
    delete process.env.SALEOR_APP_TOKEN
    const app = servidorConGuardia()

    const respuesta = await app.inject({ method: 'POST', url: '/api/webhooks/wompi-incoming', payload: {} })

    expect(respuesta.statusCode).toBe(503)
    await app.close()
  })
})

describe('POST /api/register — no escribe el token en el log', () => {
  it('responde 200: si esta respuesta falla, Saleor borra la App entera', async () => {
    // Verificado en el fork: saleor/app/installation_utils.py:302-306 hace
    // app.delete() y revierte la instalación si el POST del token falla.
    const { req } = crearRequest({ body: { auth_token: TOKEN_DE_PRUEBA } } as Partial<FastifyRequest>)
    const { reply, estado } = crearReply()

    await manejadorRegistro(req, reply)

    expect(estado.status).toBe(200)
    expect(estado.body).toEqual({ success: true })
  })

  it('el valor del token NO aparece en ninguna llamada al logger', async () => {
    // Se comprueba capturando el logger, no leyendo el código: es la única
    // forma de saber qué se escribe de verdad en un log retenido.
    const { req, log } = crearRequest({ body: { auth_token: TOKEN_DE_PRUEBA } } as Partial<FastifyRequest>)
    const { reply } = crearReply()

    await manejadorRegistro(req, reply)

    const todoLoRegistrado = JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
      log.debug.mock.calls,
      log.fatal.mock.calls,
    ])
    expect(todoLoRegistrado).not.toContain(TOKEN_DE_PRUEBA)
  })

  it('registra el evento de registro y el origen del Saleor que lo envió', async () => {
    // Sin el token no se pierde diagnóstico: sigue constando que llegó y de dónde.
    const { req, log } = crearRequest({
      body: { auth_token: TOKEN_DE_PRUEBA },
      headers: { 'saleor-domain': 'tienda.example.com', 'saleor-api-url': 'https://tienda.example.com/graphql/' },
    } as Partial<FastifyRequest>)
    const { reply } = crearReply()

    await manejadorRegistro(req, reply)

    expect(log.info).toHaveBeenCalledOnce()
    const [contexto] = log.info.mock.calls[0] as [Record<string, unknown>]
    expect(contexto.dominioSaleor).toBe('tienda.example.com')
    expect(contexto.apiUrlSaleor).toBe('https://tienda.example.com/graphql/')
  })

  it('responde 400 si el cuerpo no trae auth_token', async () => {
    const { req } = crearRequest({ body: {} } as Partial<FastifyRequest>)
    const { reply, estado } = crearReply()

    await manejadorRegistro(req, reply)

    expect(estado.status).toBe(400)
  })

  it('se sirve sin exigir registro: es el endpoint que ENTREGA el token', async () => {
    // Si /api/register exigiera token, el candado seguiría cerrado.
    delete process.env.SALEOR_APP_TOKEN
    const app = Fastify({ logger: false })
    app.post('/api/register', manejadorRegistro)

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { auth_token: TOKEN_DE_PRUEBA },
    })

    expect(respuesta.statusCode).toBe(200)
    await app.close()
  })
})
