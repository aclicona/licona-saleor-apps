import type { FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { centsToCop } from './money.js'
import { transactionIdDesdeReferencia } from './referencia.js'
import type { AccionTransaccion } from './acciones.js'
import { CODIGO_IMPORTE_INCONSISTENTE, CODIGO_TRANSACCION_INEXISTENTE } from './saleor-errors.js'
import type { SaleorTransactionEventType, TransactionEventReportResult } from './saleor-client.js'
import { WOMPI_TO_SALEOR } from '../webhooks/wompi-incoming.js'
import {
  conciliarSolicitudesPendientes,
  type LectorSolicitudesSaleor,
  type PoliticaSolicitud,
  type ResultadoSolicitudes,
} from './conciliacion-solicitudes.js'

/**
 * Backstop de conciliación contra el API de Wompi (B-412).
 *
 * Los reintentos de Wompi son finitos: si Saleor está caído más que su ventana, la confirmación de un
 * pago real se pierde. Este módulo es la red de seguridad. NO es una cola ni guarda estado: consulta
 * las transacciones recientes en Wompi y re-reporta cada una a Saleor con el MISMO contrato que el
 * webhook entrante (mismo mapeo `WOMPI_TO_SALEOR`, misma conversión de importe, mismo `pspReference`).
 * La idempotencia es de Saleor (`transactionEventReport` deduplica por pspReference + tipo + importe):
 * lo que ya estaba reportado vuelve `alreadyProcessed` y no cambia nada.
 *
 * Todo entra por interfaces (`FuenteTransaccionesWompi`, `ReportadorSaleor`) para probarlo con dobles.
 * No cambia el mapeo de estados: lo importa tal cual del handler entrante.
 */

export interface TransaccionConciliable {
  id: string
  status: string
  reference: string
  amount_in_cents: number
}

export interface VentanaConsulta {
  desde: Date
  hasta: Date
}

export interface FuenteTransaccionesWompi {
  /** Transacciones creadas dentro de la ventana. Lanza si el API de Wompi falla. */
  listarTransacciones(ventana: VentanaConsulta): Promise<TransaccionConciliable[]>
}

export interface ReportadorSaleor {
  reportar(params: {
    transactionId: string
    type: SaleorTransactionEventType
    amount: number
    pspReference: string
    message?: string
    /** Omitido: `accionesParaEvento(type)`. `INFO` nunca lo envía (es destructivo en Saleor). */
    availableActions?: AccionTransaccion[] | null
  }): Promise<TransactionEventReportResult>
}

export interface LogConciliacion {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
  fatal(obj: object, msg: string): void
}

export interface ResultadoConciliacion {
  revisadas: number
  /** Ya estaban en Saleor (`alreadyProcessed`): sin cambios. */
  yaReportadas: number
  /** Faltaban en Saleor y se re-reportaron: señal de que una entrega del webhook se perdió. */
  reportadas: number
  /** Estado sin mapeo (p. ej. PENDING). */
  sinMapeo: number
  /** Ajenas a esta integración: referencia que no es un ID de Saleor, o transacción inexistente en Saleor sobre un pago no cobrado (B-1113). */
  omitidas: number
  /** Fallos por transacción (Saleor, importe corrupto, rechazo de negocio). */
  errores: number
  /** El listado en Wompi falló: no se revisó nada. */
  errorApi: boolean
  /** Cierre de anulaciones pendientes (B-1083). Ausente si no está cableado. */
  anulaciones?: ResultadoSolicitudes
  /** Cierre de reembolsos pendientes (B-1077). Ausente si no está cableado. */
  reembolsos?: ResultadoSolicitudes
}

/** Dependencias opcionales del paso que cierra solicitudes pendientes (B-1083). */
export interface DepsSolicitudes {
  saleorLector: LectorSolicitudesSaleor
  politica: PoliticaSolicitud
  ahora?: Date
}

export async function conciliarTransaccionesWompi(deps: {
  wompi: FuenteTransaccionesWompi
  saleor: ReportadorSaleor
  anulaciones?: DepsSolicitudes
  reembolsos?: DepsSolicitudes
  ventana: VentanaConsulta
  log: LogConciliacion
}): Promise<ResultadoConciliacion> {
  const { wompi, saleor, ventana, log } = deps
  const r: ResultadoConciliacion = {
    revisadas: 0, yaReportadas: 0, reportadas: 0, sinMapeo: 0, omitidas: 0, errores: 0, errorApi: false,
  }

  let transacciones: TransaccionConciliable[]
  try {
    transacciones = await wompi.listarTransacciones(ventana)
  } catch (error) {
    r.errorApi = true
    log.error({ error, desde: ventana.desde, hasta: ventana.hasta }, 'Conciliación: el API de Wompi falló; no se revisó nada. La próxima corrida reintenta')
    return r
  }

  for (const txn of transacciones) {
    r.revisadas++
    const campos = { pspReference: txn.id, referencia: txn.reference, estadoWompi: txn.status }

    const tipo = WOMPI_TO_SALEOR[txn.status]
    if (!tipo) {
      r.sinMapeo++
      continue
    }

    let importeCop: number
    try {
      importeCop = centsToCop(txn.amount_in_cents)
    } catch (error) {
      r.errores++
      log.fatal({ ...campos, amountInCents: txn.amount_in_cents, error }, 'Conciliación: importe de Wompi corrupto; no se reporta. Requiere revisión humana')
      continue
    }

    const transactionId = transactionIdDesdeReferencia(txn.reference)
    if (!transactionId) {
      r.omitidas++
      if (txn.status === 'APPROVED') {
        log.fatal({ ...campos, importeCop }, 'Conciliación: pago APROBADO cuya referencia no es un ID de Saleor — dinero cobrado sin destino, requiere revisión humana')
      } else {
        log.warn({ ...campos, importeCop }, 'Conciliación: referencia ajena a esta integración en un pago no aprobado; se omite')
      }
      continue
    }

    try {
      const res = await saleor.reportar({
        transactionId,
        type: tipo,
        amount: importeCop,
        pspReference: txn.id,
        message: `Wompi: ${txn.status}`,
      })

      if (res.errors.length > 0) {
        const codigos = res.errors.map((e) => e.code)
        // B-1113: NOT_FOUND como único rechazo sobre un pago que NO cobró dinero = transacción ajena a esta
        // instancia (sandbox compartido, cruce de entornos). No hay nada que un humano pueda hacer: se avisa sin
        // el marcador (el vigilante no lo recoge) y cuenta como `omitidas`, igual que una referencia ajena.
        // Sobre CHARGE_SUCCESS NO se relaja: es dinero cobrado sin pedido (ver abajo).
        const soloInexistente = codigos.every((c) => c === CODIGO_TRANSACCION_INEXISTENTE)
        if (soloInexistente && tipo !== 'CHARGE_SUCCESS') {
          r.omitidas++
          log.warn(
            { ...campos, tipo, importeCop, errores: res.errors },
            'Conciliación: la transacción no existe en esta instancia de Saleor (transacción ajena: sandbox compartido o cruce de entornos) y el pago no fue cobrado; se omite',
          )
          continue
        }
        r.errores++
        const critico =
          codigos.includes(CODIGO_IMPORTE_INCONSISTENTE) ||
          (codigos.includes(CODIGO_TRANSACCION_INEXISTENTE) && tipo === 'CHARGE_SUCCESS')
        const registrar = critico ? log.fatal : log.error
        registrar.call(log, { ...campos, tipo, importeCop, errores: res.errors }, 'Conciliación: Saleor rechazó el evento. Permanente — requiere revisión humana')
      } else if (res.alreadyProcessed) {
        r.yaReportadas++
      } else {
        r.reportadas++
        log.warn({ ...campos, tipo, importeCop }, 'Conciliación: el evento faltaba en Saleor y se re-reportó (¿se perdió una entrega del webhook de Wompi?)')
      }
    } catch (error) {
      r.errores++
      log.error({ ...campos, tipo, error }, 'Conciliación: no se pudo reportar a Saleor; se sigue con las demás. La próxima corrida reintenta')
    }
  }

  if (deps.anulaciones) {
    r.anulaciones = await conciliarSolicitudesPendientes({ ...deps.anulaciones, saleor, ventana, log })
  }
  if (deps.reembolsos) {
    r.reembolsos = await conciliarSolicitudesPendientes({ ...deps.reembolsos, saleor, ventana, log })
  }

  log.info({ ...r, desde: ventana.desde, hasta: ventana.hasta }, 'Conciliación terminada')
  return r
}

// ─── Configuración (APAGADO por defecto) ─────────────────────────────────────

const VENTANA_POR_DEFECTO_MIN = 24 * 60
const VENTANA_MAXIMA_MIN = 7 * 24 * 60

/** Solo `"true"` exacto la enciende, y exige además el token del endpoint. */
export function conciliacionHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WOMPI_CONCILIACION_HABILITADA === 'true' && (env.WOMPI_CONCILIACION_TOKEN ?? '').trim() !== ''
}

/** Ventana `[ahora - N min, ahora]`; N inválido, ≤ 0 o > 7 días cae al default de 24 h. */
export function ventanaDeConciliacion(env: NodeJS.ProcessEnv = process.env, ahora: Date = new Date()): VentanaConsulta {
  const n = Number(env.WOMPI_CONCILIACION_VENTANA_MINUTOS)
  const minutos = Number.isInteger(n) && n > 0 && n <= VENTANA_MAXIMA_MIN ? n : VENTANA_POR_DEFECTO_MIN
  return { desde: new Date(ahora.getTime() - minutos * 60_000), hasta: ahora }
}

// ─── Candado compartido (HTTP + temporizador) ────────────────────────────────

let enCurso = false

/**
 * Candado booleano en memoria, COMPARTIDO por el handler HTTP y el temporizador
 * (`conciliacion-periodica.ts`): nunca hay dos conciliaciones a la vez en este proceso. No cubre
 * réplicas distintas; ahí la idempotencia de Saleor hace inocuo el duplicado.
 */
export const candadoConciliacion = {
  /** `true` si lo tomó; `false` si ya estaba tomado. */
  tomar(): boolean {
    if (enCurso) return false
    enCurso = true
    return true
  },
  liberar(): void {
    enCurso = false
  },
  tomado(): boolean {
    return enCurso
  },
}

// ─── Disparo por HTTP (protegido) ────────────────────────────────────────────

function tokenValido(cabecera: string | undefined, esperado: string): boolean {
  const recibido = Buffer.from((cabecera ?? '').replace(/^Bearer /, ''))
  const esperadoBuf = Buffer.from(esperado)
  return recibido.length === esperadoBuf.length && timingSafeEqual(recibido, esperadoBuf)
}

/**
 * Handler de `POST /api/conciliacion/ejecutar`. La ruta solo se registra si `conciliacionHabilitada()`;
 * aun así exige `Authorization: Bearer <WOMPI_CONCILIACION_TOKEN>`. Síncrono: devuelve el resumen.
 */
export function crearHandlerConciliacion(deps: {
  wompi: FuenteTransaccionesWompi
  saleor: ReportadorSaleor
  anulaciones?: DepsSolicitudes
  reembolsos?: DepsSolicitudes
}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!tokenValido(req.headers.authorization, process.env.WOMPI_CONCILIACION_TOKEN ?? '')) {
      return reply.status(401).send({ error: 'No autorizado' })
    }
    if (!candadoConciliacion.tomar()) {
      return reply.status(409).send({ error: 'Conciliación en curso' })
    }
    let resultado: ResultadoConciliacion
    try {
      resultado = await conciliarTransaccionesWompi({
        ...deps,
        ventana: ventanaDeConciliacion(),
        log: req.log.child({ webhook: 'conciliacion', disparador: 'http' }),
      })
    } finally {
      candadoConciliacion.liberar()
    }
    return reply.status(resultado.errorApi ? 502 : 200).send(resultado)
  }
}
