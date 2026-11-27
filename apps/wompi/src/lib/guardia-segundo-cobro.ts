/**
 * Guardia de segundo cobro (B-2616): antes de crear una transacción en Wompi se comprueba que el checkout no
 * tenga otra viva. Saleor solo sabe lo que se le ha reportado, así que quien decide es Wompi.
 * Tabla de decisión y TTL: `docs/wompi-estados.md`.
 */

import {
  obtenerTransaccionesDelCheckout,
  type AutorSaleor,
  type TransaccionDeCheckout,
  type TransaccionesDeCheckout,
} from './saleor-client.js'
import { referenciaParaWompi } from './referencia.js'
import type { WompiTransaction } from './wompi-client.js'
import { WompiHttpError } from './wompi-error.js'

/** Mensajes fijos hacia Saleor: el texto de un error va solo al log. */
export const MENSAJE_PAGO_EN_CURSO = 'Ya hay un pago en curso para este carrito'
export const MENSAJE_SIN_COMPROBAR = 'No se pudo comprobar un pago anterior; reintente'

const TTL_POR_DEFECTO_MIN = 30
/** Por debajo de esta edad, una transacción sin rastro en Wompi puede estar creándose ahora mismo. */
const VENTANA_CARRERA_MS = 30_000
/** Tope de consultas a Wompi por inicio: caben en el plazo del webhook. */
const MAX_CANDIDATAS = 5
/** Tope de toda la fase de Wompi (consultas en paralelo): deja plazo para el token y la creación. */
const TIMEOUT_FASE_WOMPI_MS = 4_000
const ESTADOS_QUE_NO_BLOQUEAN: ReadonlySet<string> = new Set(['DECLINED', 'ERROR', 'VOIDED'])
const PREFIJO_CHECKOUT = 'Checkout:'

/** `WOMPI_BLOQUEO_PENDIENTE_MIN`: entero positivo de minutos; cualquier otra cosa cae al valor por defecto. */
export function ttlBloqueoMs(env: NodeJS.ProcessEnv = process.env): number {
  const crudo = env.WOMPI_BLOQUEO_PENDIENTE_MIN?.trim() ?? ''
  const minutos = /^\d+$/.test(crudo) && Number(crudo) > 0 ? Number(crudo) : TTL_POR_DEFECTO_MIN
  return minutos * 60_000
}

/** ¿El autor es esta App? Sin `appId` conocido vale cualquier App. */
function esNuestraApp(autor: AutorSaleor, appId: string | undefined): boolean {
  return Boolean(autor?.id) && (appId === undefined || autor?.id === appId)
}

/** Otra App o un usuario. Sin autor o sin `appId` no se puede afirmar: se considera propia. */
function esAjena(t: TransaccionDeCheckout, appId: string | undefined): boolean {
  return appId !== undefined && t.createdBy !== null && t.createdBy.id !== appId
}

/**
 * ¿Pudo la App crear algo en Wompi para esta transacción? Wompi admite una sola transacción por `reference`
 * (B-1095), así que cualquier rastro de ello queda aquí: un `pspReference` o un `CHARGE_ACTION_REQUIRED` (el
 * inicio de estado desconocido responde sin psp).
 */
function conIndicioDeCobro(t: TransaccionDeCheckout): boolean {
  return Boolean(t.pspReference) || t.events.some((e) => Boolean(e.pspReference) || e.type === 'CHARGE_ACTION_REQUIRED')
}

/**
 * Cobrada, o fallada con prueba: el fallo trae `pspReference`, o lo respondió esta App y la transacción no tiene
 * ningún indicio de cobro en Wompi. Un fallo de la App anterior a un reintento con la misma clave, o el
 * «Sin transacción activa» de transaction-process tras un inicio ambiguo, NO es final: decide Wompi.
 */
function tieneResultadoFinal(t: TransaccionDeCheckout, appId: string | undefined): boolean {
  return t.events.some(
    (e) =>
      e.type === 'CHARGE_SUCCESS' ||
      (e.type === 'CHARGE_FAILURE' &&
        (Boolean(e.pspReference) || (esNuestraApp(e.createdBy, appId) && !conIndicioDeCobro(t)))),
  )
}

export function seleccionarCandidatas(
  transacciones: readonly TransaccionDeCheckout[],
  { miId, appId, ahora, ttlMs }: { miId: string; appId: string | undefined; ahora: Date; ttlMs: number },
): { candidatas: TransaccionDeCheckout[]; vencidas: TransaccionDeCheckout[] } {
  const abiertas = transacciones.filter((t) => t.id !== miId && !esAjena(t, appId) && !tieneResultadoFinal(t, appId))
  const vigente = (t: TransaccionDeCheckout) => ahora.getTime() - Date.parse(t.createdAt) < ttlMs
  return {
    candidatas: abiertas
      .filter(vigente)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_CANDIDATAS),
    vencidas: abiertas.filter((t) => !vigente(t)),
  }
}

/** Lo que Wompi dijo de una candidata: sus estados (vacío = sin rastro) o que no se pudo preguntar. */
export type ConsultaWompi = { tipo: 'wompi'; estados: string[] } | { tipo: 'fallo' }

export interface CandidataConsultada {
  candidata: TransaccionDeCheckout
  consulta: ConsultaWompi
}

export type Decision = 'proceder' | 'en_curso' | 'sin_comprobar'

/** La más antigua de dos inicios simultáneos procede; a igual instante desempata el id. */
function esAnterior(a: { id: string; createdAt: string }, b: { id: string; createdAt: string }): boolean {
  const diferencia = Date.parse(a.createdAt) - Date.parse(b.createdAt)
  return diferencia === 0 ? a.id < b.id : diferencia < 0
}

export function decidir(
  consultadas: readonly CandidataConsultada[],
  mia: { id: string; createdAt: string },
  ahora: Date,
): Decision {
  const viva = consultadas.some(
    ({ consulta }) => consulta.tipo === 'wompi' && consulta.estados.some((e) => !ESTADOS_QUE_NO_BLOQUEAN.has(e)),
  )
  if (viva) return 'en_curso'
  if (consultadas.some(({ consulta }) => consulta.tipo === 'fallo')) return 'sin_comprobar'
  const carreraPerdida = consultadas.some(
    ({ candidata, consulta }) =>
      consulta.tipo === 'wompi' &&
      consulta.estados.length === 0 &&
      ahora.getTime() - Date.parse(candidata.createdAt) < VENTANA_CARRERA_MS &&
      esAnterior(candidata, mia),
  )
  return carreraPerdida ? 'en_curso' : 'proceder'
}

/** Id del checkout solo si `sourceObject.id` es de verdad un ID global de Checkout (un Order no aplica). */
function idDeCheckout(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined
  return Buffer.from(id, 'base64').toString('utf8').startsWith(PREFIJO_CHECKOUT) ? id : undefined
}

type Registrar = (campos: object, mensaje: string) => void

export interface ParametrosGuardia {
  checkoutId: unknown
  transactionId: string
  wompi: {
    getTransaction(id: string, plazo?: AbortSignal): Promise<WompiTransaction>
    findTransactionsByReference(reference: string, plazo?: AbortSignal): Promise<WompiTransaction[]>
  }
  /** Plazo global del webhook. */
  signal: AbortSignal
  restanteMs: () => number
  log: { info: Registrar; warn: Registrar; error: Registrar }
}

export type ResultadoGuardia = { bloquear: false } | { bloquear: true; message: string }

async function consultarWompi(
  candidata: TransaccionDeCheckout,
  p: ParametrosGuardia,
  signal: AbortSignal,
): Promise<ConsultaWompi> {
  try {
    const encontradas = candidata.pspReference
      ? [await p.wompi.getTransaction(candidata.pspReference, signal)]
      : await p.wompi.findTransactionsByReference(referenciaParaWompi(candidata.id), signal)
    return { tipo: 'wompi', estados: encontradas.map((t) => t.status) }
  } catch (err) {
    // 404 por id: Wompi asegura que esa transacción no existe. Es «sin rastro», no un fallo.
    if (candidata.pspReference && err instanceof WompiHttpError && err.status === 404) {
      return { tipo: 'wompi', estados: [] }
    }
    p.log.error(
      { err, transaccionPrevia: candidata.id, restanteMs: p.restanteMs() },
      'Guardia de segundo cobro: Wompi no respondió sobre una transacción previa',
    )
    return { tipo: 'fallo' }
  }
}

/** Nunca lanza. Si Saleor no responde deja pasar (fail-open); si Wompi no responde habiendo candidata, bloquea. */
export async function comprobarSegundoCobro(p: ParametrosGuardia): Promise<ResultadoGuardia> {
  const checkoutId = idDeCheckout(p.checkoutId)
  if (!checkoutId) return { bloquear: false }

  let lectura: TransaccionesDeCheckout
  try {
    lectura = await obtenerTransaccionesDelCheckout(checkoutId, p.signal)
  } catch (err) {
    p.log.error(
      { err, restanteMs: p.restanteMs() },
      'Guardia de segundo cobro: no se pudieron leer las transacciones del checkout; se continúa sin comprobar',
    )
    return { bloquear: false }
  }

  const { appId, transacciones, erroresParciales } = lectura
  if (erroresParciales.length > 0) {
    p.log.warn(
      { erroresParciales, restanteMs: p.restanteMs() },
      'Guardia de segundo cobro: Saleor respondió con errores parciales; se decide con lo recibido',
    )
  }

  const ahora = new Date()
  const { candidatas, vencidas } = seleccionarCandidatas(transacciones, {
    miId: p.transactionId,
    appId,
    ahora,
    ttlMs: ttlBloqueoMs(),
  })
  // Solo las que llegaron a Wompi (tienen pspReference): las abandonadas sin él serían ruido.
  const vencidasEnWompi = vencidas.filter((t) => t.pspReference).map((t) => t.id)
  if (vencidasEnWompi.length > 0) {
    p.log.warn(
      { vencidas: vencidasEnWompi, restanteMs: p.restanteMs() },
      'Guardia de segundo cobro: transacciones sin resultado más antiguas que el TTL; ya no bloquean',
    )
  }
  if (candidatas.length === 0) return { bloquear: false }

  const signal = AbortSignal.any([p.signal, AbortSignal.timeout(TIMEOUT_FASE_WOMPI_MS)])
  const consultadas = await Promise.all(
    candidatas.map(async (candidata) => ({ candidata, consulta: await consultarWompi(candidata, p, signal) })),
  )
  // Si mi transacción aún no aparece en la lista, es la más nueva.
  const mia = transacciones.find((t) => t.id === p.transactionId) ?? { id: p.transactionId, createdAt: ahora.toISOString() }
  const decision = decidir(consultadas, mia, ahora)
  const campos = {
    decision,
    candidatas: consultadas.map(({ candidata, consulta }) => ({ id: candidata.id, ...consulta })),
    restanteMs: p.restanteMs(),
  }
  if (decision === 'proceder') {
    p.log.info(campos, 'Guardia de segundo cobro: sin otro pago vivo')
    return { bloquear: false }
  }
  p.log.warn(campos, 'Guardia de segundo cobro: no se crea otro cobro')
  return { bloquear: true, message: decision === 'en_curso' ? MENSAJE_PAGO_EN_CURSO : MENSAJE_SIN_COMPROBAR }
}
