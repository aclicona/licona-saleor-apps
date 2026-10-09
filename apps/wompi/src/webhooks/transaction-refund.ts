import { randomUUID } from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError, crearPlazo } from '@licona/webhook-utils'
import { wompiClient } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'
import { esRechazoDefinitivo } from '../lib/wompi-error.js'
import { PLAZO_GLOBAL_MS } from '../lib/plazo.js'
import { SEPARADOR_REEMBOLSO_SIN_ID } from '../lib/referencia-reembolso.js'

interface TransactionRefundPayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number }
}

/** Sondeo del estado del reembolso: 6 x 1,5 s = 9 s, bajo los 18 s de Saleor. */
const MAX_SONDEOS = 6
const INTERVALO_SONDEO_MS = 1500

export { PLAZO_GLOBAL_MS }

/** Mensajes fijos hacia Saleor: el texto del error real va solo al log. */
const MENSAJE_RECHAZO = 'Wompi rechazó la solicitud de reembolso'

export async function transactionRefundHandler(req: FastifyRequest, reply: FastifyReply) {
  // El plazo global cuenta desde la llegada de la petición: Saleor ya está contando sus 18 s, y la
  // descarga del JWKS al verificar la firma (timeout de jose: 5 s) también consume ese margen.
  const plazo = crearPlazo(PLAZO_GLOBAL_MS, 'Plazo global del reembolso agotado')
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-refund-requested', ...camposDeCorrelacion(req.body) })
  log.info('Webhook de Saleor recibido')

  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    // `reason` distingue "clave rotada, se resuelve sola" de "alguien está
    // probando suerte": son incidentes distintos y sin esto se ven igual.
    if (e instanceof SaleorWebhookError) log.warn({ motivo: e.reason }, e.message)
    else log.warn({ error: String(e) }, 'Fallo inesperado verificando la firma de Saleor')
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const { transaction, action } = req.body as TransactionRefundPayload
  if (!transaction.pspReference) {
    log.warn('Sin pspReference en el payload: no hay transacción de Wompi que reembolsar')
    return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: 'Sin pspReference' })
  }

  // Id del reembolso en Wompi, en cuanto se conoce: si algo falla después, el
  // reembolso YA existe y ese id es el pspReference de la respuesta no final.
  let refundId: string | undefined
  // Una sola señal (`plazo.signal`) para todas las llamadas a Wompi: cada una usa, de hecho, el tiempo
  // restante. El temporizador nace al leerla por primera vez (los return tempranos de arriba no dejan
  // nada vivo) y el `finally` de abajo lo limpia en todos los caminos posteriores.
  try {
    // Si la verificación ya consumió todo el plazo NO se llama a Wompi: antes de crear no hay nada creado,
    // y se responde por el camino no final de B-1071 (sin `result`, referencia sin-id), nunca REFUND_FAILURE.
    if (plazo.restanteMs() <= 0) throw new Error('Plazo global agotado antes de crear el reembolso')
    const cliente = wompiClient()
    let refund = await cliente.refundTransaction(transaction.pspReference, copToCents(action.amount), plazo.signal)
    // Una respuesta sin `id` es id desconocido, no la cadena "undefined".
    if (refund.id != null) refundId = String(refund.id)
    log.info({ refundId: refund.id, estadoRefund: refund.status }, 'Reembolso creado en Wompi')
    if (refundId === undefined) throw new Error('Wompi creó el reembolso sin devolver id')

    // Wompi crea el reembolso en PENDING y lo aprueba unos segundos después.
    // Se sondea dentro del presupuesto del webhook síncrono de Saleor (18 s de
    // espera de respuesta: WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT).
    for (let i = 0; i < MAX_SONDEOS && refund.status === 'PENDING'; i++) {
      // Sin tiempo para esperar y sondear dentro del plazo: se omite y se responde no final con el id ya conocido.
      if (plazo.restanteMs() <= INTERVALO_SONDEO_MS) {
        log.warn({ refundId, restanteMs: plazo.restanteMs() }, 'Plazo global casi agotado: se omite el sondeo del reembolso')
        break
      }
      await new Promise((r) => setTimeout(r, INTERVALO_SONDEO_MS))
      refund = await cliente.getRefund(refundId, plazo.signal)
    }

    const pspReference = String(refund.id)
    if (refund.status === 'APPROVED') {
      return reply.send({ result: 'REFUND_SUCCESS', amount: action.amount, pspReference })
    }
    if (refund.status === 'PENDING') {
      // SEGUIMIENTO PENDIENTE: el esquema síncrono de Saleor solo admite
      // REFUND_SUCCESS/REFUND_FAILURE; responder solo con `pspReference` (sin
      // `result`) lo trata como asíncrono: queda en REFUND_REQUEST a la espera
      // de un `transactionEventReport` que hoy nadie envía. Falta una tarea
      // que consulte GET /refunds/{id} y reporte el desenlace.
      log.warn({ refundId: refund.id }, 'Reembolso pendiente en Wompi, revisar')
      return reply.send({ pspReference })
    }
    log.warn({ refundId: refund.id, estadoRefund: refund.status }, 'Wompi no aprobó el reembolso')
    return reply.send({
      result: 'REFUND_FAILURE',
      amount: action.amount,
      pspReference,
      message: refund.status_message ?? `Reembolso ${refund.status} en Wompi`,
    })
  } catch (error) {
    // Rechazo cierto: un 4xx de validación al CREAR el reembolso (aún sin id).
    // Es la única vía hacia REFUND_FAILURE desde el catch.
    if (!refundId && esRechazoDefinitivo(error)) {
      log.error({ err: error, status: error.status, amount: action.amount }, 'Wompi rechazó crear el reembolso')
      return reply.send({ result: 'REFUND_FAILURE', amount: action.amount, message: MENSAJE_RECHAZO })
    }
    // B-1071: REFUND_FAILURE es final en Saleor. Un timeout, un fallo de red, un
    // 5xx o un fallo al sondear DESPUÉS de crear dejan el estado DESCONOCIDO (el
    // reembolso pudo crearse y el dinero moverse): marcarlo fallido invita a
    // reintentarlo y reembolsar dos veces. Saleor no tiene `result` no final en
    // la respuesta síncrona; omitirlo + `pspReference` = respuesta asíncrona, que
    // deja el evento REFUND_REQUEST. Sin id de reembolso (timeout en la propia
    // creación) se genera una referencia ÚNICA por petición: el esquema asíncrono
    // exige una y sin ella Saleor registraría un REFUND_FAILURE. No se reutiliza
    // la de la transacción: Saleor guarda un solo `request` por pspReference, así
    // que dos reembolsos pendientes con la misma referencia contarían como uno.
    // Un aborto por plazo es esperable y ya está contemplado: warn; cualquier otro fallo, error.
    const nivel = plazo.signal.aborted ? 'warn' : 'error'
    log[nivel](
      { err: error, refundId, amount: action.amount },
      'Estado del reembolso en Wompi desconocido; se responde sin resultado final (REFUND_REQUEST) para no cerrarlo como fallido',
    )
    return reply.send({ pspReference: refundId ?? `${transaction.pspReference}${SEPARADOR_REEMBOLSO_SIN_ID}${randomUUID()}` })
  } finally {
    plazo.limpiar()
  }
}
