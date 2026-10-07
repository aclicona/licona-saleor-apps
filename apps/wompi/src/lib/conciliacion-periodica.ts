import type { LogConciliacion, ResultadoConciliacion, VentanaConsulta } from './conciliacion.js'
import { candadoConciliacion } from './conciliacion.js'

/**
 * Disparador periódico EN PROCESO de la conciliación (B-412).
 *
 * Decisión de Andrés (2026-10-07) + ruling de Fable: un temporizador dentro de app-wompi, sin servicio
 * nuevo. Corre solo mientras el servicio está vivo —que es exactamente cuando hay algo que conciliar—,
 * y la conciliación es idempotente (Saleor deduplica), así que con varias réplicas las corridas se
 * duplican sin dañar nada: se acepta y se documenta en docs/conciliacion.md.
 *
 * Todo entra por `deps` para probarlo con fake timers y sin red.
 */

export const INTERVALO_POR_DEFECTO_MIN = 15
export const INTERVALO_MAXIMO_MIN = 24 * 60
/** Margen tras el arranque para que la App termine de levantar antes de la primera corrida. */
export const RETRASO_INICIAL_MS = 30_000

/**
 * Intervalo en minutos desde `WOMPI_CONCILIACION_INTERVALO_MINUTOS`.
 * Ausente → 15; `0` exacto → 0 (temporizador apagado); inválido (no entero, negativo, > 1440) → 15
 * con aviso que nombra el valor. Nunca lanza: una errata no tumba una App de pagos.
 */
export function intervaloDeConciliacion(
  env: NodeJS.ProcessEnv = process.env,
): { minutos: number; aviso: string | null } {
  const crudo = env.WOMPI_CONCILIACION_INTERVALO_MINUTOS
  if (crudo === undefined || crudo.trim() === '') return { minutos: INTERVALO_POR_DEFECTO_MIN, aviso: null }
  const texto = crudo.trim()
  const n = Number(texto)
  if (/^\d+$/.test(texto) && Number.isInteger(n) && n >= 0 && n <= INTERVALO_MAXIMO_MIN) {
    return { minutos: n, aviso: null }
  }
  return {
    minutos: INTERVALO_POR_DEFECTO_MIN,
    aviso:
      `WOMPI_CONCILIACION_INTERVALO_MINUTOS="${crudo}" no es válido (entero entre 0 y ${INTERVALO_MAXIMO_MIN}; 0 = apagado). ` +
      `Se usan ${INTERVALO_POR_DEFECTO_MIN} min`,
  }
}

export interface ProgramadorConciliacion {
  detener(): void
  enCurso(): boolean
}

export function programarConciliacionPeriodica(deps: {
  conciliar: (ventana: VentanaConsulta) => Promise<ResultadoConciliacion>
  /** `ventanaDeConciliacion()`: se llama FRESCA en cada tick (una ventana fija envejecería). */
  ventana: () => VentanaConsulta
  registrada: () => boolean
  intervaloMs: number
  retrasoInicialMs: number
  log: LogConciliacion
}): ProgramadorConciliacion {
  const { conciliar, ventana, registrada, intervaloMs, retrasoInicialMs, log } = deps
  const contexto = { webhook: 'conciliacion', disparador: 'timer' }
  let temporizador: NodeJS.Timeout | undefined
  let detenido = false
  let saltosConsecutivos = 0

  function armar(retrasoMs: number): void {
    if (detenido) return
    temporizador = setTimeout(() => void tick(), retrasoMs)
    temporizador.unref()
  }

  async function tick(): Promise<void> {
    try {
      if (!registrada()) {
        log.warn(contexto, 'Conciliación periódica: la App no está registrada en Saleor; se salta esta corrida')
      } else if (!candadoConciliacion.tomar()) {
        saltosConsecutivos++
        log.warn(
          { ...contexto, saltosConsecutivos },
          'Conciliación periódica: ya hay una conciliación en curso; se salta esta corrida',
        )
      } else {
        saltosConsecutivos = 0
        try {
          await conciliar(ventana())
        } finally {
          candadoConciliacion.liberar()
        }
      }
    } catch (error) {
      log.error({ ...contexto, error }, 'Conciliación periódica: la corrida lanzó una excepción; se re-arma igual')
    }
    armar(intervaloMs)
  }

  armar(retrasoInicialMs)

  return {
    detener() {
      detenido = true
      if (temporizador) clearTimeout(temporizador)
    },
    enCurso: () => candadoConciliacion.tomado(),
  }
}
