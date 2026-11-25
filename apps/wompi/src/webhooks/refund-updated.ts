import type { FastifyReply, FastifyRequest } from 'fastify'
import { MENSAJE_REEMBOLSO_OK } from '../lib/decision-reembolso.js'
import { eventoFresco } from '../lib/contraste-wompi.js'
import { centsToCop } from '../lib/money.js'
import { transactionIdDesdeReferencia } from '../lib/referencia.js'
import { clasificarFalloSaleor, CODIGO_IMPORTE_INCONSISTENTE } from '../lib/saleor-errors.js'
import { obtenerEventosTransaccion, reportTransactionEvent } from '../lib/saleor-client.js'
import type { EventoFirmado } from '../lib/wompi-signature.js'
import { wompiClient, type WompiRefund } from '../lib/wompi-client.js'
import { WompiHttpError } from '../lib/wompi-error.js'

/**
 * Evento `refund.updated` de Wompi (B-2525). Llega por `wompi-incoming` con la MISMA verificación de firma que
 * `transaction.updated` (la hace el handler antes de despachar aquí). Wompi solo notifica estados finales
 * (APPROVED, DECLINED, ERROR, CANCELLED); PENDING/PROCESSING (B-2523) no cierran nada.
 *
 * Es un acelerador: la conciliación de reembolsos pendientes (B-1077, cada 15 min) sigue siendo la red de seguridad.
 * Por eso ante cualquier duda se NO reporta y se deja a la conciliación, nunca se adivina:
 *  - Solo se cierra un `REFUND_REQUEST` cuyo `pspReference` sea EXACTAMENTE el id del reembolso. Un request sin id
 *    (`…:reembolso-sin-id:…`) lo casa la conciliación; reportar aquí un SUCCESS con otro psp lo contaría dos veces.
 *  - Si ya hay REFUND_SUCCESS/REFUND_FAILURE con ese psp (cierre síncrono o evento repetido) no se reporta de nuevo.
 *  - El evento se contrasta con `GET /refunds/{id}` (id, estado, importe, transacción), como B-1900 hace con pagos.
 */

type TipoCierre = 'REFUND_SUCCESS' | 'REFUND_FAILURE'

const ESTADOS_FALLIDOS = new Set(['DECLINED', 'ERROR', 'CANCELLED'])

interface ReembolsoDeEvento {
  id: string | number
  status: string
  amount_in_cents: number
  transaction_id: string
}

/** APPROVED → éxito; DECLINED/ERROR/CANCELLED → fallo; cualquier otro (PENDING, PROCESSING, desconocido) → `undefined`. */
export function cierreDeEstadoReembolso(estado: string): TipoCierre | undefined {
  if (estado === 'APPROVED') return 'REFUND_SUCCESS'
  return ESTADOS_FALLIDOS.has(estado) ? 'REFUND_FAILURE' : undefined
}

type Log = FastifyRequest['log']

function ok(reply: FastifyReply) {
  return reply.status(200).send({ ok: true })
}

function coincide(evento: ReembolsoDeEvento, real: WompiRefund): boolean {
  return (
    String(real.id) === String(evento.id) &&
    real.status === evento.status &&
    real.amount_in_cents === evento.amount_in_cents &&
    String(real.transaction_id) === String(evento.transaction_id)
  )
}

export async function reembolsoActualizado(reply: FastifyReply, baseLog: Log, event: EventoFirmado) {
  const refund = (event.data as { refund?: ReembolsoDeEvento } | undefined)?.refund
  if (!refund || refund.id == null || typeof refund.status !== 'string') {
    baseLog.error('Evento refund.updated con firma válida pero sin data.refund utilizable')
    return ok(reply)
  }
  const pspReference = String(refund.id)
  const log = baseLog.child({ refundId: pspReference, pspReference })

  if (!eventoFresco(event.timestamp)) {
    log.warn({ motivo: 'EVENTO_FUERA_DE_VENTANA', estadoWompi: refund.status }, 'Evento de reembolso fuera de la ventana de frescura — rechazado')
    return reply.status(401).send({ error: 'Evento fuera de la ventana de frescura' })
  }

  const tipo = cierreDeEstadoReembolso(refund.status)
  if (!tipo) {
    log.info({ estadoWompi: refund.status }, 'Reembolso de Wompi aún no final (o estado sin mapeo) — nada que reportar')
    return ok(reply)
  }

  let importeCop: number
  try {
    importeCop = centsToCop(refund.amount_in_cents)
  } catch (error) {
    log.fatal({ amountInCents: refund.amount_in_cents, error }, 'Importe de reembolso de Wompi corrupto: no se reporta. Requiere revisión humana')
    return ok(reply)
  }

  // Contraste con la fuente de verdad ANTES de reportar (la firma solo cubre lo que el evento enumera).
  let real: WompiRefund
  let referencia: string
  try {
    const wompi = wompiClient()
    real = await wompi.getRefund(pspReference)
    if (!coincide(refund, real)) {
      log.warn({ estadoWompi: refund.status, estadoReal: real.status }, 'El evento de reembolso no coincide con el reembolso real de Wompi — rechazado sin reportar')
      return reply.status(401).send({ error: 'Evento no verificado contra Wompi' })
    }
    referencia = (await wompi.getTransaction(String(real.transaction_id))).reference
  } catch (error) {
    if (error instanceof WompiHttpError && error.status === 404) {
      log.warn({ estadoWompi: refund.status }, 'Wompi no conoce el reembolso o su transacción — rechazado sin reportar')
      return reply.status(401).send({ error: 'Evento no verificado contra Wompi' })
    }
    log.warn({ estadoWompi: refund.status, error }, 'No se pudo contrastar el reembolso con Wompi. Se devuelve 500 para que Wompi reintente')
    return reply.status(500).send({ error: 'No se pudo verificar el evento con Wompi' })
  }

  const transactionId = transactionIdDesdeReferencia(referencia)
  if (!transactionId) {
    log.warn({ estadoWompi: refund.status }, 'Reembolso de una transacción cuya referencia no es de Saleor: evento ajeno, no se reporta')
    return ok(reply)
  }

  try {
    const eventos = await obtenerEventosTransaccion(transactionId)
    if (!eventos) {
      log.warn({ estadoWompi: refund.status }, 'La transacción del reembolso no existe en Saleor: no se reporta')
      return ok(reply)
    }
    const delPsp = eventos.filter((e) => e.pspReference === pspReference)
    if (delPsp.some((e) => e.type === 'REFUND_SUCCESS' || e.type === 'REFUND_FAILURE')) {
      log.info({ tipo }, 'Reembolso ya cerrado en Saleor: el evento repetido no reporta nada')
      return ok(reply)
    }
    if (!delPsp.some((e) => e.type === 'REFUND_REQUEST')) {
      log.info({ tipo }, 'Saleor no tiene un REFUND_REQUEST con este id (aún no respondió el reembolso o es sin-id): lo cierra la conciliación')
      return ok(reply)
    }

    const resultado = await reportTransactionEvent({
      transactionId,
      type: tipo,
      amount: importeCop,
      pspReference,
      message: tipo === 'REFUND_SUCCESS' ? MENSAJE_REEMBOLSO_OK : `Wompi no aprobó el reembolso (${refund.status})`,
    })
    if (resultado.errors.length > 0) {
      const fatal = resultado.errors.some((e) => e.code === CODIGO_IMPORTE_INCONSISTENTE)
      log[fatal ? 'fatal' : 'error'](
        { tipo, errores: resultado.errors },
        'Saleor rechazó el cierre del reembolso. Permanente: no se pide reintento — requiere revisión humana',
      )
    } else if (resultado.alreadyProcessed) {
      log.info({ tipo }, 'Reembolso ya procesado por Saleor (alreadyProcessed)')
    } else {
      log.info({ tipo }, 'Reembolso cerrado en Saleor por el evento refund.updated')
    }
    return ok(reply)
  } catch (error) {
    const clasificacion = clasificarFalloSaleor(error)
    log[clasificacion === 'AUTENTICACION' ? 'error' : 'warn'](
      { tipo, error },
      'Saleor no atendió el cierre del reembolso. Se devuelve 500 para que Wompi reintente',
    )
    return reply.status(500).send({ error: 'No se pudo reportar el evento a Saleor' })
  }
}
