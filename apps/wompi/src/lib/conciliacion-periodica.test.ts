import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RETRASO_INICIAL_MS,
  intervaloDeConciliacion,
  programarConciliacionPeriodica,
} from './conciliacion-periodica.js'
import { candadoConciliacion, type ResultadoConciliacion, type VentanaConsulta } from './conciliacion.js'

const MIN = 60_000
const RESULTADO: ResultadoConciliacion = {
  revisadas: 0, yaReportadas: 0, reportadas: 0, sinMapeo: 0, omitidas: 0, errores: 0, errorApi: false,
}

function crearLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log
}

describe('intervaloDeConciliacion', () => {
  it('ausente → 15 sin aviso', () => {
    expect(intervaloDeConciliacion({})).toEqual({ minutos: 15, aviso: null })
  })
  it("'0' → 0 (apagado) y '5' → 5, sin aviso", () => {
    expect(intervaloDeConciliacion({ WOMPI_CONCILIACION_INTERVALO_MINUTOS: '0' })).toEqual({ minutos: 0, aviso: null })
    expect(intervaloDeConciliacion({ WOMPI_CONCILIACION_INTERVALO_MINUTOS: '5' })).toEqual({ minutos: 5, aviso: null })
  })
  it.each(['abc', '-1', '1.5', '99999'])('%s → 15 con aviso que nombra el valor', (valor) => {
    const r = intervaloDeConciliacion({ WOMPI_CONCILIACION_INTERVALO_MINUTOS: valor })
    expect(r.minutos).toBe(15)
    expect(r.aviso).toContain(valor)
  })
})

describe('programarConciliacionPeriodica', () => {
  const VENT: VentanaConsulta = { desde: new Date(0), hasta: new Date(1) }
  let log: ReturnType<typeof crearLog>
  let registrada: boolean

  function programar(conciliar: (v: VentanaConsulta) => Promise<ResultadoConciliacion>, ventana = () => VENT) {
    return programarConciliacionPeriodica({
      conciliar,
      ventana,
      registrada: () => registrada,
      intervaloMs: 15 * MIN,
      retrasoInicialMs: RETRASO_INICIAL_MS,
      log,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    log = crearLog()
    registrada = true
  })
  afterEach(() => {
    candadoConciliacion.liberar()
    vi.useRealTimers()
  })

  it('primera corrida tras el retraso inicial y no antes; luego una por intervalo', async () => {
    const conciliar = vi.fn().mockResolvedValue(RESULTADO)
    const p = programar(conciliar)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS - 1)
    expect(conciliar).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(conciliar).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3 * 15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(4)
    p.detener()
  })

  it('invoca ventana() en cada tick y pasa su valor a conciliar', async () => {
    const conciliar = vi.fn().mockResolvedValue(RESULTADO)
    const v1 = { desde: new Date(1), hasta: new Date(2) }
    const v2 = { desde: new Date(3), hasta: new Date(4) }
    const ventana = vi.fn().mockReturnValueOnce(v1).mockReturnValueOnce(v2)
    const p = programar(conciliar, ventana)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS + 15 * MIN)
    expect(ventana).toHaveBeenCalledTimes(2)
    expect(conciliar).toHaveBeenNthCalledWith(1, v1)
    expect(conciliar).toHaveBeenNthCalledWith(2, v2)
    p.detener()
  })

  it('App no registrada → no concilia, avisa, y corre al registrarse', async () => {
    const conciliar = vi.fn().mockResolvedValue(RESULTADO)
    registrada = false
    const p = programar(conciliar)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS)
    expect(conciliar).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'Conciliación periódica: la App no está registrada en Saleor; se salta esta corrida',
    )
    registrada = true
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(1)
    p.detener()
  })

  it('solape: no lanza una segunda corrida con la primera en curso; avisa; reanuda al resolver', async () => {
    let resolver!: (r: ResultadoConciliacion) => void
    const conciliar = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ResultadoConciliacion>((res) => { resolver = res }))
      .mockResolvedValue(RESULTADO)
    const p = programar(conciliar)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS)
    expect(p.enCurso()).toBe(true)
    // Mientras sigue en curso el temporizador no está armado: se re-arma al terminar.
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(1)
    resolver(RESULTADO)
    await vi.advanceTimersByTimeAsync(0)
    expect(p.enCurso()).toBe(false)
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(2)
    p.detener()
  })

  it('candado tomado por otro disparador (HTTP) → salta con warn y cuenta saltos consecutivos', async () => {
    const conciliar = vi.fn().mockResolvedValue(RESULTADO)
    expect(candadoConciliacion.tomar()).toBe(true)
    const p = programar(conciliar)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS + 15 * MIN)
    expect(conciliar).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ saltosConsecutivos: 2 }),
      expect.stringContaining('en curso'),
    )
    candadoConciliacion.liberar()
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(1)
    p.detener()
  })

  it('conciliar rechaza → log.error, libera el candado y el siguiente tick corre', async () => {
    const conciliar = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(RESULTADO)
    const p = programar(conciliar)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(p.enCurso()).toBe(false)
    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(2)
    p.detener()
  })

  it('detener() → no más llamadas', async () => {
    const conciliar = vi.fn().mockResolvedValue(RESULTADO)
    const p = programar(conciliar)
    await vi.advanceTimersByTimeAsync(RETRASO_INICIAL_MS)
    p.detener()
    await vi.advanceTimersByTimeAsync(5 * 15 * MIN)
    expect(conciliar).toHaveBeenCalledTimes(1)
  })
})
