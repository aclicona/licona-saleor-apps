import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  conciliarTransaccionesWompi,
  conciliacionHabilitada,
  candadoConciliacion,
  crearHandlerConciliacion,
  ventanaDeConciliacion,
  type FuenteTransaccionesWompi,
  type ReportadorSaleor,
  type TransaccionConciliable,
} from './conciliacion.js'
import { politicaAnulaciones, politicaReembolsos } from './conciliacion-solicitudes.js'

// Referencia con forma de ID global de Saleor (misma que usa wompi-incoming.test.ts).
const REF = 'VHJhbnNhY3Rpb25JdGVtOmEyMGVkNTc2LTNkOGMtNDliMi1iZGUzLTgwYzA3NmExNzUzYg=='

function txn(parcial: Partial<TransaccionConciliable> = {}): TransaccionConciliable {
  return { id: 'wompi-1', status: 'APPROVED', reference: REF, amount_in_cents: 12000000, ...parcial }
}

function crearLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}

function fuente(transacciones: TransaccionConciliable[]): FuenteTransaccionesWompi {
  return { listarTransacciones: vi.fn().mockResolvedValue(transacciones) }
}

function saleor(resultado?: Partial<Awaited<ReturnType<ReportadorSaleor['reportar']>>>): ReportadorSaleor {
  return {
    reportar: vi.fn().mockResolvedValue({ alreadyProcessed: false, transactionId: 'T', errors: [], ...resultado }),
  }
}

const VENTANA = { desde: new Date('2026-10-01T00:00:00Z'), hasta: new Date('2026-10-02T00:00:00Z') }

describe('conciliarTransaccionesWompi', () => {
  it('ya reportada (alreadyProcessed) → no hace nada nuevo y no avisa', async () => {
    const log = crearLog()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn()]),
      saleor: saleor({ alreadyProcessed: true }),
      ventana: VENTANA,
      log,
    })
    expect(r).toMatchObject({ revisadas: 1, yaReportadas: 1, reportadas: 0, errores: 0, errorApi: false })
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('falta en Saleor → re-reporta con el mismo contrato que el webhook y lo avisa como señal de entrega perdida', async () => {
    const log = crearLog()
    const s = saleor({ alreadyProcessed: false })
    const r = await conciliarTransaccionesWompi({ wompi: fuente([txn()]), saleor: s, ventana: VENTANA, log })
    expect(s.reportar).toHaveBeenCalledWith({
      transactionId: REF,
      type: 'CHARGE_SUCCESS',
      amount: 120000,
      pspReference: 'wompi-1',
      message: 'Wompi: APPROVED',
    })
    expect(r).toMatchObject({ reportadas: 1, yaReportadas: 0 })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('usa el mapeo de estados existente (VOIDED → CHARGE_FAILURE, DECLINED/ERROR → CHARGE_FAILURE)', async () => {
    const s = saleor()
    await conciliarTransaccionesWompi({
      wompi: fuente([txn({ id: 'a', status: 'VOIDED' }), txn({ id: 'b', status: 'DECLINED' }), txn({ id: 'c', status: 'ERROR' })]),
      saleor: s,
      ventana: VENTANA,
      log: crearLog(),
    })
    const tipos = vi.mocked(s.reportar).mock.calls.map(([p]) => p.type)
    expect(tipos).toEqual(['CHARGE_FAILURE', 'CHARGE_FAILURE', 'CHARGE_FAILURE'])
  })

  it('estado sin mapeo (PENDING) → no se reporta', async () => {
    const s = saleor()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn({ status: 'PENDING' })]),
      saleor: s,
      ventana: VENTANA,
      log: crearLog(),
    })
    expect(s.reportar).not.toHaveBeenCalled()
    expect(r.sinMapeo).toBe(1)
  })

  it('error del API de Wompi → registra, no lanza y no toca Saleor', async () => {
    const log = crearLog()
    const s = saleor()
    const r = await conciliarTransaccionesWompi({
      wompi: { listarTransacciones: vi.fn().mockRejectedValue(new Error('Wompi 503')) },
      saleor: s,
      ventana: VENTANA,
      log,
    })
    expect(r).toMatchObject({ errorApi: true, revisadas: 0 })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(s.reportar).not.toHaveBeenCalled()
  })

  it('error de Saleor en una transacción → registra y sigue con las demás', async () => {
    const log = crearLog()
    const s: ReportadorSaleor = {
      reportar: vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ alreadyProcessed: false, transactionId: 'T', errors: [] }),
    }
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn({ id: 'a' }), txn({ id: 'b' })]),
      saleor: s,
      ventana: VENTANA,
      log,
    })
    expect(s.reportar).toHaveBeenCalledTimes(2)
    expect(r).toMatchObject({ revisadas: 2, errores: 1, reportadas: 1 })
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('errores de negocio de Saleor → cuentan como error; fatal si es un cobro APROBADO con importe inconsistente', async () => {
    const log = crearLog()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn()]),
      saleor: saleor({ errors: [{ field: null, message: 'x', code: 'INCORRECT_DETAILS' }] }),
      ventana: VENTANA,
      log,
    })
    expect(r.errores).toBe(1)
    expect(log.fatal).toHaveBeenCalledTimes(1)
  })

  it('referencia que no es un ID de Saleor → omitida (fatal solo si APPROVED), sin llamar a Saleor', async () => {
    const log = crearLog()
    const s = saleor()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn({ reference: 'ajena-123' }), txn({ id: 'x', status: 'DECLINED', reference: 'ajena-456' })]),
      saleor: s,
      ventana: VENTANA,
      log,
    })
    expect(s.reportar).not.toHaveBeenCalled()
    expect(r.omitidas).toBe(2)
    expect(log.fatal).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('importe corrupto → error fatal, no se reporta y se sigue', async () => {
    const log = crearLog()
    const s = saleor()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn({ amount_in_cents: Number.NaN }), txn({ id: 'ok' })]),
      saleor: s,
      ventana: VENTANA,
      log,
    })
    expect(s.reportar).toHaveBeenCalledTimes(1)
    expect(r.errores).toBe(1)
    expect(log.fatal).toHaveBeenCalledTimes(1)
  })

  it('es idempotente: dos corridas sobre los mismos datos reportan lo mismo (el dedup es de Saleor)', async () => {
    const s = saleor({ alreadyProcessed: true })
    const args = { wompi: fuente([txn()]), saleor: s, ventana: VENTANA, log: crearLog() }
    const a = await conciliarTransaccionesWompi(args)
    const b = await conciliarTransaccionesWompi(args)
    expect(a).toEqual(b)
  })
})

describe('conciliacionHabilitada — APAGADA por defecto', () => {
  it('sin variable → apagada', () => expect(conciliacionHabilitada({})).toBe(false))
  it('solo "true" exacto la enciende, y exige token', () => {
    expect(conciliacionHabilitada({ WOMPI_CONCILIACION_HABILITADA: 'true' })).toBe(false)
    expect(conciliacionHabilitada({ WOMPI_CONCILIACION_HABILITADA: 'TRUE', WOMPI_CONCILIACION_TOKEN: 't' })).toBe(false)
    expect(conciliacionHabilitada({ WOMPI_CONCILIACION_HABILITADA: 'true', WOMPI_CONCILIACION_TOKEN: 't' })).toBe(true)
  })
})

describe('ventanaDeConciliacion', () => {
  const ahora = new Date('2026-10-02T12:00:00Z')
  it('default 24 h', () => {
    expect(ventanaDeConciliacion({}, ahora)).toEqual({ desde: new Date('2026-10-01T12:00:00Z'), hasta: ahora })
  })
  it('respeta la variable en minutos y cae al default si es inválida o excede el tope', () => {
    expect(ventanaDeConciliacion({ WOMPI_CONCILIACION_VENTANA_MINUTOS: '60' }, ahora).desde).toEqual(new Date('2026-10-02T11:00:00Z'))
    expect(ventanaDeConciliacion({ WOMPI_CONCILIACION_VENTANA_MINUTOS: 'abc' }, ahora).desde).toEqual(new Date('2026-10-01T12:00:00Z'))
    expect(ventanaDeConciliacion({ WOMPI_CONCILIACION_VENTANA_MINUTOS: '999999' }, ahora).desde).toEqual(new Date('2026-10-01T12:00:00Z'))
  })
})

describe('crearHandlerConciliacion — protegido por token', () => {
  const OLD = { ...process.env }
  afterEach(() => { process.env = { ...OLD } })
  function reply() {
    const r: { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } = { status: vi.fn(), send: vi.fn() }
    r.status.mockReturnValue(r)
    r.send.mockReturnValue(r)
    return r
  }
  const req = (authorization?: string) =>
    ({ headers: { authorization }, log: { child: () => crearLog() } }) as unknown as FastifyRequest

  it('sin token o con token erróneo → 401 y no consulta Wompi', async () => {
    process.env.WOMPI_CONCILIACION_TOKEN = 'secreto'
    const f = fuente([txn()])
    const h = crearHandlerConciliacion({ wompi: f, saleor: saleor() })
    for (const a of [undefined, 'Bearer otro', 'Bearer secret']) {
      const r = reply()
      await h(req(a), r as unknown as FastifyReply)
      expect(r.status).toHaveBeenCalledWith(401)
    }
    expect(f.listarTransacciones).not.toHaveBeenCalled()
  })

  it('con token correcto → 200 con el resumen; 502 si falla el API de Wompi', async () => {
    process.env.WOMPI_CONCILIACION_TOKEN = 'secreto'
    const ok = reply()
    await crearHandlerConciliacion({ wompi: fuente([txn()]), saleor: saleor({ alreadyProcessed: true }) })(req('Bearer secreto'), ok as unknown as FastifyReply)
    expect(ok.status).toHaveBeenCalledWith(200)
    const mal = reply()
    await crearHandlerConciliacion({ wompi: { listarTransacciones: vi.fn().mockRejectedValue(new Error('x')) }, saleor: saleor() })(req('Bearer secreto'), mal as unknown as FastifyReply)
    expect(mal.status).toHaveBeenCalledWith(502)
  })
  it('con la conciliación ya en curso (candado tomado) → 409 y no consulta Wompi', async () => {
    process.env.WOMPI_CONCILIACION_TOKEN = 'secreto'
    const f = fuente([txn()])
    expect(candadoConciliacion.tomar()).toBe(true)
    try {
      const r = reply()
      await crearHandlerConciliacion({ wompi: f, saleor: saleor() })(req('Bearer secreto'), r as unknown as FastifyReply)
      expect(r.status).toHaveBeenCalledWith(409)
      expect(r.send).toHaveBeenCalledWith({ error: 'Conciliación en curso' })
      expect(f.listarTransacciones).not.toHaveBeenCalled()
    } finally {
      candadoConciliacion.liberar()
    }
  })

  it('libera el candado al terminar, también si la corrida falla', async () => {
    process.env.WOMPI_CONCILIACION_TOKEN = 'secreto'
    await crearHandlerConciliacion({ wompi: fuente([txn()]), saleor: saleor({ alreadyProcessed: true }) })(req('Bearer secreto'), reply() as unknown as FastifyReply)
    expect(candadoConciliacion.tomado()).toBe(false)
  })
})

describe('conciliarTransaccionesWompi — paso de anulaciones (B-1083)', () => {
  const CLAVES_DE_SIEMPRE = ['revisadas', 'yaReportadas', 'reportadas', 'sinMapeo', 'omitidas', 'errores', 'errorApi', 'desde', 'hasta']

  function anulacionesCableadas() {
    return {
      saleorLector: { listarTransaccionesConSolicitud: vi.fn().mockResolvedValue([]) },
      politica: politicaAnulaciones({ getTransaction: vi.fn() }),
    }
  }

  it('cableado: «Conciliación terminada» lleva las claves de siempre más anulaciones; sin cablear no aparece', async () => {
    const conLog = crearLog()
    await conciliarTransaccionesWompi({
      wompi: fuente([]), saleor: saleor(), ventana: VENTANA, log: conLog, anulaciones: anulacionesCableadas(),
    })
    const [campos, mensaje] = conLog.info.mock.calls.at(-1)!
    expect(mensaje).toBe('Conciliación terminada')
    expect(Object.keys(campos).sort()).toEqual([...CLAVES_DE_SIEMPRE, 'anulaciones'].sort())
    expect(campos.anulaciones).toMatchObject({ candidatas: 0, errorApi: false })

    const sinLog = crearLog()
    await conciliarTransaccionesWompi({ wompi: fuente([]), saleor: saleor(), ventana: VENTANA, log: sinLog })
    expect(Object.keys(sinLog.info.mock.calls.at(-1)![0]).sort()).toEqual([...CLAVES_DE_SIEMPRE].sort())
  })

  it('corre aunque una transacción del primer bucle haya fallado', async () => {
    const s: ReportadorSaleor = { reportar: vi.fn().mockRejectedValue(new Error('Saleor caído')) }
    const anulaciones = anulacionesCableadas()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([txn()]), saleor: s, ventana: VENTANA, log: crearLog(), anulaciones,
    })
    expect(r.errores).toBe(1)
    expect(anulaciones.saleorLector.listarTransaccionesConSolicitud).toHaveBeenCalledTimes(1)
    expect(r.anulaciones).toBeDefined()
  })
})

describe('conciliarTransaccionesWompi — paso de reembolsos (B-1077)', () => {
  const BASE = ['revisadas', 'yaReportadas', 'reportadas', 'sinMapeo', 'omitidas', 'errores', 'errorApi', 'desde', 'hasta']
  const vacio = () => ({ saleorLector: { listarTransaccionesConSolicitud: vi.fn().mockResolvedValue([]) } })
  const reembolsosCableados = () => ({ ...vacio(), politica: politicaReembolsos({ getRefund: vi.fn(), getTransaction: vi.fn() }) })
  const anulacionesCableadas = () => ({ ...vacio(), politica: politicaAnulaciones({ getTransaction: vi.fn() }) })

  it('el log lleva anulaciones y reembolsos; sin cablear reembolsos no aparece esa clave', async () => {
    const conLog = crearLog()
    await conciliarTransaccionesWompi({
      wompi: fuente([]), saleor: saleor(), ventana: VENTANA, log: conLog,
      anulaciones: anulacionesCableadas(), reembolsos: reembolsosCableados(),
    })
    const [campos, mensaje] = conLog.info.mock.calls.at(-1)!
    expect(mensaje).toBe('Conciliación terminada')
    expect(Object.keys(campos).sort()).toEqual([...BASE, 'anulaciones', 'reembolsos'].sort())
    expect(campos.reembolsos).toMatchObject({ candidatas: 0, errorApi: false })

    const soloAnul = crearLog()
    await conciliarTransaccionesWompi({ wompi: fuente([]), saleor: saleor(), ventana: VENTANA, log: soloAnul, anulaciones: anulacionesCableadas() })
    expect(Object.keys(soloAnul.info.mock.calls.at(-1)![0]).sort()).toEqual([...BASE, 'anulaciones'].sort())
  })

  it('corre aunque el paso de anulaciones dé errorApi', async () => {
    const anulaciones = {
      saleorLector: { listarTransaccionesConSolicitud: vi.fn().mockRejectedValue(new Error('Saleor caído')) },
      politica: politicaAnulaciones({ getTransaction: vi.fn() }),
    }
    const reembolsos = reembolsosCableados()
    const r = await conciliarTransaccionesWompi({
      wompi: fuente([]), saleor: saleor(), ventana: VENTANA, log: crearLog(), anulaciones, reembolsos,
    })
    expect(r.anulaciones?.errorApi).toBe(true)
    expect(reembolsos.saleorLector.listarTransaccionesConSolicitud).toHaveBeenCalledTimes(1)
    expect(r.reembolsos).toMatchObject({ errorApi: false })
  })
})
