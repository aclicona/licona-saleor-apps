import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// El cliente de Saleor se mockea entero: estos tests son sobre la SEMÁNTICA DE
// ENTREGA (qué código HTTP se le devuelve a Wompi según el fallo), no sobre
// GraphQL. Por eso `clasificarFalloSaleor` vive en otro módulo — así el mock
// del cliente no se lleva por delante la lógica que se está probando.
vi.mock('../lib/saleor-client.js', () => ({
  reportTransactionEvent: vi.fn(),
}))

import { reportTransactionEvent } from '../lib/saleor-client.js'
import { wompiIncomingHandler } from './wompi-incoming.js'

const reportTransactionEventMock = vi.mocked(reportTransactionEvent)

const SECRET = 'secreto-de-eventos-de-prueba'

/**
 * Reimplementación INDEPENDIENTE del checksum documentado por Wompi
 * (https://docs.wompi.co/en/docs/colombia/eventos/): SHA-256 sobre la
 * concatenación sin separadores de los valores de `signature.properties`, el
 * `signature.timestamp` y el secreto de eventos.
 *
 * Se reimplementa aquí a propósito, sin importar nada de `lib/wompi-signature`:
 * si el test firmara con el mismo código que verifica, un error en el algoritmo
 * se cancelaría consigo mismo y la suite pasaría en verde con la firma
 * equivocada — que es exactamente el bug que se está corrigiendo.
 *
 * El algoritmo en sí se prueba a fondo en `lib/wompi-signature.test.ts`; aquí
 * lo que se prueba es que la verificación es INCONDICIONAL y que un fallo de
 * firma corta antes de tocar Saleor.
 */
function calcularChecksum(evento: EventoDePrueba, secret: string): string {
  const valores = evento.signature.properties.map((ruta) =>
    String(ruta.split('.').reduce<unknown>((acc, clave) => (acc as Record<string, unknown>)?.[clave], evento.data)),
  )
  // Mayúsculas: es como Wompi lo publica, y de paso ejercita que la comparación
  // del handler no dependa de mayúsculas/minúsculas.
  return createHash('sha256')
    .update(valores.join('') + evento.signature.timestamp + secret)
    .digest('hex')
    .toUpperCase()
}

interface EventoDePrueba {
  event?: string
  data: Record<string, unknown>
  signature: { properties: string[]; timestamp: number; checksum?: string }
}

/** Dónde se coloca el checksum: Wompi lo envía por los dos sitios a la vez. */
type UbicacionChecksum = 'ambos' | 'cabecera' | 'cuerpo'

interface OpcionesPeticion {
  evento?: EventoDePrueba
  checksum?: string
  ubicacion?: UbicacionChecksum
  secret?: string
}

/** Doble de FastifyRequest con logger espiable. */
function crearRequest({ evento, checksum, ubicacion = 'ambos', secret = SECRET }: OpcionesPeticion = {}) {
  const base = evento ?? eventoWompi()
  // Un evento SIN bloque signature no se puede firmar: se deja tal cual para
  // poder probar ese caso degenerado a través del handler.
  const valor = checksum ?? (base.signature ? calcularChecksum(base, secret) : '')

  const cuerpo: EventoDePrueba = base.signature
    ? {
        ...base,
        signature: {
          ...base.signature,
          ...(ubicacion === 'cabecera' ? {} : { checksum: valor }),
        },
      }
    : base
  const rawBody = JSON.stringify(cuerpo)

  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }

  const req = {
    rawBody,
    body: cuerpo,
    headers: ubicacion === 'cuerpo' ? {} : { 'x-event-checksum': valor },
    log,
  }

  return { req: req as unknown as FastifyRequest, log, rawBody }
}

/** Doble de FastifyReply que registra el status y el cuerpo enviados. */
function crearReply() {
  const captura: { status: number; payload: unknown } = { status: 200, payload: undefined }

  const reply = {
    status(codigo: number) {
      captura.status = codigo
      return reply
    },
    send(payload: unknown) {
      captura.payload = payload
      return reply
    },
  }

  return { reply: reply as unknown as FastifyReply, captura }
}

function eventoWompi(
  overrides: Partial<{ id: string; status: string; reference: string; amount_in_cents: number }> = {},
): EventoDePrueba {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: 'wompi-txn-12345',
        status: 'APPROVED',
        reference: 'VHJhbnNhY3Rpb246YWJj',
        amount_in_cents: 12_000_000,
        ...overrides,
      },
    },
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      timestamp: 1_700_000_000,
    },
  }
}

/** Respuesta feliz por defecto de `transactionEventReport`. */
function resultadoOk(overrides: Partial<{ alreadyProcessed: boolean; errors: unknown[] }> = {}) {
  return {
    alreadyProcessed: false,
    transactionId: 'VHJhbnNhY3Rpb246YWJj',
    errors: [],
    ...overrides,
  } as Awaited<ReturnType<typeof reportTransactionEvent>>
}

/** Imita el `ClientError` de graphql-request para un status HTTP dado. */
function errorHttpSaleor(status: number) {
  return Object.assign(new Error(`Saleor respondió ${status}`), {
    response: { status, errors: [] },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WOMPI_EVENTS_SECRET = SECRET
})

afterEach(() => {
  delete process.env.WOMPI_EVENTS_SECRET
})

describe('wompiIncomingHandler — verificación de firma', () => {
  it('rechaza con 401 una firma inválida y NO llama a Saleor', () => {
    const { req } = crearRequest({ checksum: 'A'.repeat(64) })
    const { reply, captura } = crearReply()

    return wompiIncomingHandler(req, reply).then(() => {
      expect(captura.status).toBe(401)
      expect(reportTransactionEventMock).not.toHaveBeenCalled()
    })
  })

  it('rechaza con 401 una firma calculada con otro secreto', async () => {
    const { req } = crearRequest({ secret: 'secreto-del-atacante' })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })

  it('rechaza con 401 cuando no viene checksum por ningún lado', async () => {
    const { req } = crearRequest({ checksum: '' })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })

  it('acepta el checksum recibido SOLO por la cabecera X-Event-Checksum', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk())

    const { req } = crearRequest({ ubicacion: 'cabecera' })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).toHaveBeenCalledTimes(1)
  })

  it('acepta el checksum recibido SOLO por signature.checksum del cuerpo', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk())

    const { req } = crearRequest({ ubicacion: 'cuerpo' })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).toHaveBeenCalledTimes(1)
  })

  it('rechaza con 401 si se manipula el timestamp firmado', async () => {
    // El timestamp entra literalmente en la cadena firmada, así que reusar un
    // checksum legítimo con otro timestamp tiene que romper la verificación.
    const evento = eventoWompi()
    const checksumLegitimo = calcularChecksum(evento, SECRET)
    const { req } = crearRequest({
      evento: { ...evento, signature: { ...evento.signature, timestamp: 1_799_999_999 } },
      checksum: checksumLegitimo,
    })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })

  it('rechaza con 401 si se manipula el importe manteniendo el checksum legítimo', async () => {
    // El escenario que de verdad importa: alguien reenvía un evento real con el
    // importe inflado. `amount_in_cents` está en signature.properties, así que
    // el checksum deja de cuadrar.
    const evento = eventoWompi()
    const checksumLegitimo = calcularChecksum(evento, SECRET)
    const { req } = crearRequest({ evento: eventoWompi({ amount_in_cents: 1 }), checksum: checksumLegitimo })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })

  it('registra el motivo del rechazo para distinguir un ataque de un cambio de formato de Wompi', async () => {
    const { req, log } = crearRequest({ evento: { ...eventoWompi(), signature: undefined as never } })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(log.warn).toHaveBeenCalled()
    expect(JSON.stringify(log.warn.mock.calls)).toContain('SIN_BLOQUE_SIGNATURE')
  })

  it('verifica INCONDICIONALMENTE: sin WOMPI_EVENTS_SECRET un POST anónimo sigue dando 401', async () => {
    // Regresión del agujero original: la verificación iba envuelta en
    // `if (secret && ...)`, así que con la variable vacía cualquier POST
    // anónimo podía reportar un CHARGE_SUCCESS y marcar pagada una orden impaga.
    delete process.env.WOMPI_EVENTS_SECRET

    const { req } = crearRequest({ checksum: '' })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })

  it('verifica INCONDICIONALMENTE: sin secreto, ni siquiera un evento bien formado pasa', async () => {
    // Sin secreto no hay nada contra qué verificar; el lado seguro es 401,
    // nunca "no puedo comprobarlo, lo doy por bueno".
    delete process.env.WOMPI_EVENTS_SECRET

    const { req } = crearRequest({ secret: '' })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(401)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })
})

describe('wompiIncomingHandler — camino feliz', () => {
  it('responde 200 y reporta a Saleor con el pspReference correcto', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk())

    const { req } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).toHaveBeenCalledTimes(1)
    expect(reportTransactionEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        // El pspReference DEBE ser el id de Wompi: es estable entre reintentos
        // y es la clave con la que Saleor deduplica del lado servidor.
        pspReference: 'wompi-txn-12345',
        transactionId: 'VHJhbnNhY3Rpb246YWJj',
        type: 'CHARGE_SUCCESS',
      }),
    )
  })

  it('convierte los centavos de Wompi a COP con centsToCop, sin lógica inline', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk())

    const { req } = crearRequest({ evento: eventoWompi({ amount_in_cents: 1999 }) })
    const { reply } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(reportTransactionEventMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 19.99 }))
  })

  it('mapea un DECLINED de Wompi a CHARGE_FAILURE', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk())

    const { req } = crearRequest({ evento: eventoWompi({ status: 'DECLINED' }) })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'CHARGE_FAILURE' }))
  })
})

describe('wompiIncomingHandler — fallos transitorios (500, Wompi debe reintentar)', () => {
  it('responde 500 cuando la llamada a Saleor da timeout', async () => {
    reportTransactionEventMock.mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )

    const { req } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    // 200 aquí perdería para siempre la confirmación de un pago real: Wompi
    // daría el evento por entregado y no reintentaría.
    expect(captura.status).toBe(500)
  })

  it('responde 500 cuando falla la red contra Saleor', async () => {
    const errorRed = new TypeError('fetch failed')
    Object.assign(errorRed, { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    reportTransactionEventMock.mockRejectedValue(errorRed)

    const { req } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(500)
  })

  it('responde 500 cuando Saleor devuelve 500', async () => {
    reportTransactionEventMock.mockRejectedValue(errorHttpSaleor(500))

    const { req } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(500)
  })

  it('responde 500 cuando Saleor devuelve 429 (rate limit)', async () => {
    reportTransactionEventMock.mockRejectedValue(errorHttpSaleor(429))

    const { req } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(500)
  })

  it('responde 500 y loguea a nivel error cuando el token de la App es inválido (401)', async () => {
    reportTransactionEventMock.mockRejectedValue(errorHttpSaleor(401))

    const { req, log } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    // El evento es válido; la instancia está rota. Un humano rota el token y
    // el siguiente reintento de Wompi entra solo — por eso 500 y no 200.
    expect(captura.status).toBe(500)
    expect(log.error).toHaveBeenCalled()
    expect(JSON.stringify(log.error.mock.calls)).toContain('SALEOR_APP_TOKEN')
  })

  it('responde 500 y loguea a nivel error cuando Saleor deniega el permiso (403)', async () => {
    reportTransactionEventMock.mockRejectedValue(errorHttpSaleor(403))

    const { req, log } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(500)
    expect(log.error).toHaveBeenCalled()
  })
})

describe('wompiIncomingHandler — fallos permanentes (200, ningún reintento converge)', () => {
  it('responde 200 y loguea a nivel crítico ante INCORRECT_DETAILS', async () => {
    reportTransactionEventMock.mockResolvedValue(
      resultadoOk({
        errors: [
          { field: 'pspReference', message: 'Providing different amount is not allowed.', code: 'INCORRECT_DETAILS' },
        ],
      }),
    )

    const { req, log, rawBody } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    // Permanente por definición: el payload que Wompi reintentaría es el mismo
    // que Saleor acaba de rechazar. Pedir reintento sería un bucle infinito.
    expect(captura.status).toBe(200)
    expect(log.fatal).toHaveBeenCalled()

    // El log crítico tiene que llevar el payload crudo: es la única prueba de
    // qué se recibió exactamente ante una posible manipulación del importe.
    const [contexto, mensaje] = log.fatal.mock.calls[0] as [Record<string, unknown>, string]
    expect(contexto.rawBody).toBe(rawBody)
    expect(contexto.pspReference).toBe('wompi-txn-12345')
    expect(mensaje).toContain('INCORRECT_DETAILS')
  })

  it('responde 200 y loguea a nivel error cuando la transacción no existe en Saleor', async () => {
    reportTransactionEventMock.mockResolvedValue(
      resultadoOk({
        errors: [{ field: 'id', message: "Couldn't resolve to an object.", code: 'NOT_FOUND' }],
      }),
    )

    const { req, log } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(log.error).toHaveBeenCalled()
  })

  it('responde 200 y loguea a nivel error ante cualquier otro error de negocio', async () => {
    reportTransactionEventMock.mockResolvedValue(
      resultadoOk({ errors: [{ field: 'amount', message: 'Invalid amount.', code: 'INVALID' }] }),
    )

    const { req, log } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(log.error).toHaveBeenCalled()
  })

  it('responde 200 y loguea a nivel crítico cuando el importe de Wompi es corrupto', async () => {
    const { req, log } = crearRequest({ evento: eventoWompi({ amount_in_cents: 1999.5 }) })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    // Un importe fraccionario en centavos es un payload corrupto o manipulado:
    // no se reporta a Saleor un importe inventado y no se pide reintento.
    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
    expect(log.fatal).toHaveBeenCalled()
  })

  it('responde 200 sin llamar a Saleor cuando el evento no trae data.transaction', async () => {
    // Firma VÁLIDA pero sin transacción. `signature.properties` puede variar
    // entre eventos según la doc de Wompi, así que un evento legítimo puede
    // firmar campos que no son los de una transacción: aquí se firma `nequi`
    // para que el 401 no enmascare el camino que se quiere probar.
    const { req } = crearRequest({
      evento: {
        event: 'nequi_token.updated',
        data: { nequi: { status: 'APPROVED' } },
        signature: { properties: ['nequi.status'], timestamp: 1_700_000_000 },
      },
    })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })
})

describe('wompiIncomingHandler — estados de Wompi sin mapeo', () => {
  it('responde 200 sin llamar a Saleor cuando el estado es PENDING', async () => {
    const { req } = crearRequest({ evento: eventoWompi({ status: 'PENDING' }) })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
  })

  it('registra el estado LITERAL para poder detectar estados nuevos de Wompi leyendo logs', async () => {
    const { req, log } = crearRequest({ evento: eventoWompi({ status: 'ESTADO_QUE_WOMPI_AUN_NO_TIENE' }) })
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(reportTransactionEventMock).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalled()
    expect(JSON.stringify(log.info.mock.calls)).toContain('ESTADO_QUE_WOMPI_AUN_NO_TIENE')
  })
})

describe('wompiIncomingHandler — idempotencia del lado servidor', () => {
  it('responde 200 y deja registro cuando Saleor devuelve alreadyProcessed', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk({ alreadyProcessed: true }))

    const { req, log } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)

    // Evidencia observable de que la semántica funciona: Wompi reintentó,
    // Saleor reconoció el evento previo y no duplicó nada. Es un camino sano
    // (info, no warn) pero tiene que quedar registrado con pspReference y tipo.
    expect(log.info).toHaveBeenCalled()
    const registro = JSON.stringify(log.info.mock.calls)
    expect(registro).toContain('wompi-txn-12345')
    expect(registro).toContain('CHARGE_SUCCESS')
    expect(registro).toContain('alreadyProcessed')
  })

  it('no registra alreadyProcessed cuando el evento sí era nuevo', async () => {
    reportTransactionEventMock.mockResolvedValue(resultadoOk({ alreadyProcessed: false }))

    const { req, log } = crearRequest()
    const { reply, captura } = crearReply()

    await wompiIncomingHandler(req, reply)

    expect(captura.status).toBe(200)
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('alreadyProcessed')
  })
})
