import type { FastifyRequest, FastifyReply } from 'fastify'
import { centsToCop } from '../lib/money.js'
import { reportTransactionEvent } from '../lib/saleor-client.js'
import {
  CODIGO_IMPORTE_INCONSISTENTE,
  CODIGO_TRANSACCION_INEXISTENTE,
  clasificarFalloSaleor,
} from '../lib/saleor-errors.js'
import { CABECERA_CHECKSUM, verificarFirmaWompi, type EventoFirmado } from '../lib/wompi-signature.js'
import { camposDeCorrelacionWompi } from '../lib/correlacion.js'
import { transactionIdDesdeReferencia } from '../lib/referencia.js'

const WOMPI_TO_SALEOR: Record<string, 'CHARGE_SUCCESS' | 'CHARGE_FAILURE'> = {
  APPROVED: 'CHARGE_SUCCESS',
  DECLINED: 'CHARGE_FAILURE',
  ERROR: 'CHARGE_FAILURE',
  VOIDED: 'CHARGE_FAILURE',
}

interface WompiEvent extends EventoFirmado {
  data: { transaction: { id: string; status: string; reference: string; amount_in_cents: number } }
}

/**
 * Webhook entrante de Wompi.
 *
 * ── Semántica de entrega ────────────────────────────────────────────────────
 * El procesamiento es SÍNCRONO y el código HTTP de la respuesta es lo que
 * clasifica el fallo. No hay cola propia (el reintento de Wompi es la cola) ni
 * deduplicación propia (`transactionEventReport` deduplica del lado servidor
 * por `pspReference` + `type` + importe). Duplicar cualquiera de las dos cosas
 * sería código que puede divergir de la fuente de verdad.
 *
 * La regla que decide el status, y de la que salen todos los casos de abajo:
 *
 *   ¿un reintento IDÉNTICO mañana puede tener éxito sin que cambie el payload?
 *     sí → 5xx (Wompi reintenta; Saleor deduplica el reintento gratis)
 *     no → 2xx + log ruidoso (ningún reintento va a converger; que lo vea un humano)
 *
 * Y la regla que decide, dentro de ese 2xx, cuánto ruido hace el log:
 *
 *   **la severidad la decide el importe en riesgo, no el código de error.**
 *
 * Por eso el mismo fallo aparece abajo con dos severidades según el estado del
 * pago: un evento huérfano de una transacción DECLINED es ruido operativo, y el
 * mismo evento huérfano sobre un cobro APROBADO es dinero que nadie va a
 * acreditar. Tratar los dos como `fatal` acabaría con nadie mirando los `fatal`.
 *
 * | Fallo                                    | Respuesta   | Señal concreta que lo distingue              |
 * |------------------------------------------|-------------|----------------------------------------------|
 * | Firma inválida                           | 401         | el SHA-256 documentado no coincide           |
 * | Saleor caído/timeout/red/5xx/429         | 500         | la llamada LANZA → clasificada TRANSITORIO   |
 * | Token de App inválido o expirado         | 500 + error | la llamada LANZA → clasificada AUTENTICACION |
 * | Importe inconsistente (INCORRECT_DETAILS)| 200 + fatal | código en `errors[]` de la mutación          |
 * | Referencia que no es un ID de Saleor     | 200 + fatal si APPROVED, warn si no | `transactionIdDesdeReferencia` devuelve undefined |
 * | Transacción inexistente en Saleor        | 200 + fatal si CHARGE_SUCCESS, error si no | código NOT_FOUND en `errors[]` |
 * | Importe de Wompi corrupto                | 200 + fatal | `centsToCop` lanza                           |
 * | Estado de Wompi sin mapeo                | 200 + info  | `WOMPI_TO_SALEOR[status]` undefined          |
 *
 * El único `try/catch` envuelve exclusivamente la llamada a Saleor, y por eso
 * puede responder 500 sin ser un catch genérico: todo lo que falla ahí dentro
 * significa, por construcción, "el evento NO llegó a Saleor". Los fallos que
 * no son eso (payload corrupto, estado desconocido) se resuelven fuera del
 * catch y responden 200.
 */
export async function wompiIncomingHandler(req: FastifyRequest, reply: FastifyReply) {
  const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? ''
  const secret = process.env.WOMPI_EVENTS_SECRET ?? ''
  const event = req.body as WompiEvent

  // Clave de unión con el resto de la cadena: el id de la transacción en Wompi
  // es exactamente el `pspReference` que esta App reporta a Saleor. Se extrae
  // de forma defensiva y ANTES de verificar la firma, para que los eventos
  // rechazados también se puedan cruzar con los aceptados.
  const log = req.log.child({ webhook: 'wompi-incoming', ...camposDeCorrelacionWompi(event) })
  log.info({ evento: (event as { event?: string })?.event ?? null }, 'Evento entrante de Wompi recibido')

  // Verificación INCONDICIONAL. Antes iba envuelta en `if (secret && ...)`, así
  // que con la variable vacía no se verificaba nada y cualquier POST anónimo
  // podía reportar un CHARGE_SUCCESS y marcar como pagada una orden impaga.
  // El caso "no hay secret" ya no puede llegar aquí: lo corta el fail-fast del
  // arranque (ver lib/config.ts). Si aun así llegara, `verificarFirmaWompi`
  // rechaza explícitamente con SECRETO_AUSENTE, que es el lado seguro.
  //
  // El algoritmo vive en lib/wompi-signature.ts y NO usa el rawBody: Wompi no
  // firma los bytes del cuerpo (como sí hace el JWS de Saleor) sino los valores
  // que el propio evento enumera en `signature.properties`. El checksum se toma
  // de la cabecera X-Event-Checksum y/o de `signature.checksum`.
  const firma = verificarFirmaWompi(event, req.headers[CABECERA_CHECKSUM] as string | undefined, secret)
  if (!firma.valido) {
    // El motivo se registra porque distingue "alguien está probando suerte" de
    // "Wompi cambió el formato del evento y hay que actualizar la App" — dos
    // incidentes muy distintos que sin esto se ven exactamente igual en el log.
    log.warn(
      { motivo: firma.motivo, detalle: firma.detalle, rawBody },
      'Firma de Wompi inválida — evento rechazado sin reportar a Saleor',
    )
    return reply.status(401).send({ error: 'Firma inválida' })
  }

  const txn = event?.data?.transaction
  if (!txn) {
    // Firma válida pero sin transacción en el cuerpo. Permanente: el payload
    // no va a cambiar por reintentar.
    log.error({ rawBody }, 'Evento de Wompi con firma válida pero sin data.transaction')
    return reply.status(200).send({ ok: true })
  }

  const saleorEventType = WOMPI_TO_SALEOR[txn.status]
  if (!saleorEventType) {
    // No es un error: Wompi tiene estados intermedios (PENDING) y puede añadir
    // otros. Se registra el estado LITERAL para poder detectar estados nuevos
    // de Wompi leyendo logs, sin tener que reproducir el evento.
    log.info(
      { estadoWompi: txn.status, referencia: txn.reference },
      'Estado de Wompi sin mapeo a evento de Saleor — nada que reportar',
    )
    return reply.status(200).send({ ok: true })
  }

  // Conversión centavos → COP fuera del try/catch de Saleor: un importe
  // corrupto es un fallo PERMANENTE del payload, no un fallo de entrega.
  let importeCop: number
  try {
    importeCop = centsToCop(txn.amount_in_cents)
  } catch (error) {
    log.fatal(
      { referencia: txn.reference, amountInCents: txn.amount_in_cents, rawBody, error },
      'Importe de Wompi corrupto: no se reporta a Saleor. Ningún reintento lo arregla — requiere revisión humana',
    )
    return reply.status(200).send({ ok: true })
  }

  // La referencia la manda Wompi en el cuerpo, así que puede no ser un ID de
  // transacción de Saleor por causas perfectamente reales: una cuenta de
  // comercio compartida con otra integración, una transacción de prueba creada a
  // mano en el panel, un cruce de entornos. Hasta ahora se le pasaba tal cual a
  // `transactionEventReport` y lo único que se veía era un NOT_FOUND genérico,
  // que no distingue "referencia ajena" de "la transacción se borró de Saleor".
  //
  // Va DESPUÉS de la conversión del importe y no antes, aunque los dos fallos
  // sean permanentes y respondan 200. La razón no es el orden lógico sino el
  // contenido de la alerta: cuando la referencia es basura y el cobro está
  // APROBADO, lo primero que necesita saber un humano es CUÁNTO dinero quedó sin
  // destino, y ese importe solo existe una vez que `centsToCop` lo ha validado.
  // Al revés, el fatal diría "hay un cobro huérfano" sin poder decir de cuánto.
  // Y si además el importe viniera corrupto, gana esa alerta, que es la que dice
  // que el payload entero no es de fiar.
  const transactionIdSaleor = transactionIdDesdeReferencia(txn.reference)
  if (!transactionIdSaleor) {
    // 200 porque ningún reintento converge: Wompi reenviaría exactamente la
    // misma referencia. Un 500 aquí sería un bucle infinito de reintentos.
    //
    // La severidad la decide el importe en riesgo, no el código de error. Con
    // APPROVED hay dinero cobrado que Saleor no va a poder atribuir a ninguna
    // transacción: mismo trato que INCORRECT_DETAILS, `fatal` y con el payload
    // crudo, que es la única prueba de qué se recibió exactamente. Con cualquier
    // otro estado esto es ruido esperable de una cuenta compartida, y un `fatal`
    // incondicional convertiría ese ruido en páginas a un humano de madrugada.
    if (txn.status === 'APPROVED') {
      log.fatal(
        { referencia: txn.reference, tipo: saleorEventType, importeCop, rawBody },
        'Pago APROBADO cuya referencia no es un ID de transacción de Saleor: el cobro existe en Wompi ' +
          'pero no hay transacción a la que acreditarlo, y el evento no se reporta. ' +
          'Ningún reintento lo arregla — es dinero cobrado sin destino, requiere revisión humana inmediata',
      )
    } else {
      log.warn(
        { referencia: txn.reference, tipo: saleorEventType, estadoWompi: txn.status, importeCop },
        'Referencia de Wompi que no es un ID de transacción de Saleor en un pago no aprobado: ' +
          'evento ajeno a esta integración (cuenta de comercio compartida, prueba manual o cruce de entornos). ' +
          'No hay dinero en riesgo: no se reporta a Saleor y no se pide reintento',
      )
    }
    return reply.status(200).send({ ok: true })
  }

  let resultado
  try {
    resultado = await reportTransactionEvent({
      // El ID verificado, no `txn.reference` otra vez: así lo que llega a la
      // mutación es el valor que la validación acaba de garantizar, y no una
      // coincidencia entre dos lecturas del mismo campo que alguien podría
      // desincronizar más adelante sin que ningún test se entere.
      transactionId: transactionIdSaleor,
      type: saleorEventType,
      amount: importeCop,
      pspReference: txn.id,
      message: `Wompi: ${txn.status}`,
    })
  } catch (error) {
    const clasificacion = clasificarFalloSaleor(error)

    if (clasificacion === 'AUTENTICACION') {
      log.error(
        { referencia: txn.reference, tipo: saleorEventType, error },
        'Saleor rechazó la autenticación de la App: el evento es válido pero la instancia está rota. ' +
          'Rotar SALEOR_APP_TOKEN — el siguiente reintento de Wompi entrará solo',
      )
    } else {
      log.warn(
        { referencia: txn.reference, tipo: saleorEventType, error },
        'Saleor no atendió el reporte del evento (transitorio). Se devuelve 500 para que Wompi reintente',
      )
    }

    // 500 = "no lo di por entregado". Es la única forma de pedirle a Wompi que
    // reintente; un 200 aquí perdería para siempre la confirmación de un pago real.
    return reply.status(500).send({ error: 'No se pudo reportar el evento a Saleor' })
  }

  if (resultado.errors.length > 0) {
    const codigos = resultado.errors.map((e) => e.code)

    if (codigos.includes(CODIGO_IMPORTE_INCONSISTENTE)) {
      // Saleor ya tiene un evento con este pspReference + type pero con OTRO
      // importe. Es permanente por definición: el payload que Wompi reintenta
      // es el mismo que Saleor acaba de rechazar. O Wompi es inconsistente
      // consigo mismo, o alguien manipuló el importe. Se registra el payload
      // crudo porque es la única prueba de qué se recibió exactamente.
      log.fatal(
        {
          referencia: txn.reference,
          tipo: saleorEventType,
          importeCop,
          errores: resultado.errors,
          rawBody,
        },
        'INCORRECT_DETAILS: Saleor ya registró este pspReference con un importe distinto. ' +
          'Posible inconsistencia de Wompi o manipulación del importe — requiere revisión humana inmediata',
      )
    } else if (codigos.includes(CODIGO_TRANSACCION_INEXISTENTE)) {
      // Aquí la referencia SÍ tenía forma de ID de Saleor —la validación de más
      // arriba la dejó pasar— pero Saleor no la reconoce: la transacción se
      // borró, o el evento viene de otra instancia con el mismo formato de ID.
      //
      // Se aplica el mismo criterio que al resto del handler: la severidad la
      // decide el importe en riesgo, no el código de error. Un CHARGE_SUCCESS es
      // un pago que Wompi ya confirmó y que no se va a acreditar en ninguna
      // orden — el mismo caso que INCORRECT_DETAILS, dinero perdido, y por eso
      // lleva el `rawBody` como prueba. Un CHARGE_FAILURE no mueve dinero: es un
      // evento huérfano que hay que mirar, no una emergencia.
      if (saleorEventType === 'CHARGE_SUCCESS') {
        log.fatal(
          { referencia: txn.reference, tipo: saleorEventType, importeCop, errores: resultado.errors, rawBody },
          'NOT_FOUND sobre un pago APROBADO: Wompi confirmó el cobro y Saleor no reconoce la transacción, ' +
            'así que el pago no queda acreditado en ninguna orden. Permanente: no se pide reintento — ' +
            'es dinero cobrado y perdido, requiere revisión humana inmediata',
        )
      } else {
        log.error(
          { referencia: txn.reference, tipo: saleorEventType, errores: resultado.errors },
          'La transacción referenciada no existe en Saleor (cruce de entornos o transacción borrada). ' +
            'Sin dinero en riesgo porque el pago no fue aprobado. Permanente: no se pide reintento',
        )
      }
    } else {
      // Los demás códigos de transactionEventReport (INVALID, REQUIRED,
      // GRAPHQL_ERROR, ALREADY_EXISTS) son validaciones de payload o de
      // estado: ninguno converge reintentando el mismo evento.
      log.error(
        { referencia: txn.reference, errores: resultado.errors },
        'Saleor rechazó el evento por un error de negocio. Permanente: no se pide reintento',
      )
    }

    return reply.status(200).send({ ok: true })
  }

  if (resultado.alreadyProcessed) {
    // Evidencia observable de que la idempotencia del lado servidor funciona:
    // Wompi reintentó, Saleor reconoció el evento previo y no duplicó nada.
    // Es un camino sano, por eso info y no warn.
    log.info(
      { tipo: saleorEventType, referencia: txn.reference },
      'Evento ya procesado por Saleor: el reintento de Wompi convergió sin duplicar (alreadyProcessed)',
    )
  }

  return reply.status(200).send({ ok: true })
}
