import { describe, it, expect, vi } from 'vitest'
import {
  conciliarSolicitudesPendientes,
  politicaAnulaciones,
  solicitudesSinResolver,
  type LectorSolicitudesSaleor,
} from './conciliacion-solicitudes.js'
import type { ReportadorSaleor } from './conciliacion.js'
import type { EventoTransaccionSaleor, TransaccionConSolicitudes } from './saleor-client.js'
import type { WompiTransaction } from './wompi-client.js'

const AHORA = new Date('2026-10-08T12:00:00Z')
const VENTANA = { desde: new Date('2026-10-07T12:00:00Z'), hasta: AHORA }
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString()

function crearLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
}

function evento(parcial: Partial<EventoTransaccionSaleor> = {}): EventoTransaccionSaleor {
  return { type: 'CANCEL_REQUEST', pspReference: 'psp-A', createdAt: hace(10), amount: 120000, ...parcial }
}

function transaccion(parcial: Partial<TransaccionConSolicitudes> = {}): TransaccionConSolicitudes {
  return { id: 'T1', cancelPendingAmount: 120000, refundPendingAmount: 0, events: [evento()], ...parcial }
}

function lector(ts: TransaccionConSolicitudes[]): LectorSolicitudesSaleor {
  return { listarTransaccionesConSolicitud: vi.fn().mockResolvedValue(ts) }
}

function saleor(resultado: Record<string, unknown> = {}): ReportadorSaleor {
  return { reportar: vi.fn().mockResolvedValue({ alreadyProcessed: false, transactionId: 'T1', errors: [], ...resultado }) }
}

function wompi(txn: Partial<WompiTransaction> | Error | Record<string, Partial<WompiTransaction> | Error>) {
  const respuesta = (id: string) => {
    const t = ('status' in txn || txn instanceof Error ? txn : (txn as Record<string, Partial<WompiTransaction>>)[id]) as
      | Partial<WompiTransaction>
      | Error
    if (t instanceof Error) throw t
    const completa: WompiTransaction = {
      id, status: 'APPROVED', reference: 'r', amount_in_cents: 12000000, currency: 'COP', payment_method_type: 'CARD', ...t,
    }
    return completa
  }
  return { getTransaction: vi.fn(async (id: string) => respuesta(id)) }
}

async function correr(ts: TransaccionConSolicitudes[], w: ReturnType<typeof wompi>, s = saleor(), log = crearLog()) {
  const r = await conciliarSolicitudesPendientes({
    saleorLector: lector(ts), saleor: s, politica: politicaAnulaciones(w), ventana: VENTANA, ahora: AHORA, log,
  })
  return { r, s, log }
}

describe('conciliarSolicitudesPendientes (anulaciones)', () => {
  it('VOIDED con request pendiente → un CANCEL_SUCCESS con el psp y el importe del request', async () => {
    const { r, s, log } = await correr([transaccion()], wompi({ status: 'VOIDED' }))
    expect(s.reportar).toHaveBeenCalledTimes(1)
    expect(s.reportar).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'T1', type: 'CANCEL_SUCCESS', amount: 120000, pspReference: 'psp-A' }),
    )
    expect(r).toMatchObject({ candidatas: 1, cerradasExito: 1, cerradasFallo: 0, errores: 0 })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('cancelPendingAmount 0 → no consulta Wompi ni Saleor', async () => {
    const w = wompi({ status: 'VOIDED' })
    const { r, s } = await correr([transaccion({ cancelPendingAmount: 0 })], w)
    expect(r.candidatas).toBe(0)
    expect(w.getTransaction).not.toHaveBeenCalled()
    expect(s.reportar).not.toHaveBeenCalled()
  })

  it('request con CANCEL_SUCCESS del mismo psp pero pendiente > 0 → sin decidir, error y sin reporte', async () => {
    const t = transaccion({ events: [evento(), evento({ type: 'CANCEL_SUCCESS' })] })
    const { r, s, log } = await correr([t], wompi({ status: 'VOIDED' }))
    expect(r).toMatchObject({ candidatas: 1, sinDecidir: 1 })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(s.reportar).not.toHaveBeenCalled()
  })

  it('dos requests: el psp A con CANCEL_FAILURE y el B abierto → solo cierra B', async () => {
    const t = transaccion({
      events: [
        evento({ pspReference: 'psp-A' }),
        evento({ type: 'CANCEL_FAILURE', pspReference: 'psp-A' }),
        evento({ pspReference: 'psp-B' }),
      ],
    })
    expect(solicitudesSinResolver(t, politicaAnulaciones(wompi({}))).map((e) => e.pspReference)).toEqual(['psp-B'])
    const { s } = await correr([t], wompi({ status: 'VOIDED' }))
    expect(s.reportar).toHaveBeenCalledTimes(1)
    expect(s.reportar).toHaveBeenCalledWith(expect.objectContaining({ pspReference: 'psp-B' }))
  })

  it('APPROVED dentro del margen → en espera, sin reporte', async () => {
    const { r, s } = await correr([transaccion()], wompi({ status: 'APPROVED' }))
    expect(r).toMatchObject({ candidatas: 1, enEspera: 1 })
    expect(s.reportar).not.toHaveBeenCalled()
  })

  it('APPROVED pasado el margen → CANCEL_FAILURE con el importe del request y mensaje fijo', async () => {
    const t = transaccion({ events: [evento({ createdAt: hace(61) })] })
    const { r, s } = await correr([t], wompi({ status: 'APPROVED' }))
    expect(s.reportar).toHaveBeenCalledWith({
      transactionId: 'T1',
      type: 'CANCEL_FAILURE',
      amount: 120000,
      pspReference: 'psp-A',
      message: 'La anulación no se aplicó en Wompi (sigue APPROVED pasado el margen)',
    })
    expect(r.cerradasFallo).toBe(1)
  })

  it.each(['PENDING', 'DECLINED', 'ERROR'] as const)('%s → sin decidir con error que lleva estadoWompi', async (status) => {
    const { r, s, log } = await correr([transaccion()], wompi({ status }))
    expect(r.sinDecidir).toBe(1)
    expect(s.reportar).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ estadoWompi: status }), expect.any(String))
  })

  it('el lector lanza → errorApi y no lanza', async () => {
    const log = crearLog()
    const r = await conciliarSolicitudesPendientes({
      saleorLector: { listarTransaccionesConSolicitud: vi.fn().mockRejectedValue(new Error('boom')) },
      saleor: saleor(), politica: politicaAnulaciones(wompi({})), ventana: VENTANA, ahora: AHORA, log,
    })
    expect(r.errorApi).toBe(true)
    expect(log.error).toHaveBeenCalled()
  })

  it('getTransaction falla en una de dos → errores 1 y la otra se cierra', async () => {
    const ts = [
      transaccion({ id: 'T1', events: [evento({ pspReference: 'psp-A' })] }),
      transaccion({ id: 'T2', events: [evento({ pspReference: 'psp-B' })] }),
    ]
    const { r, s } = await correr(ts, wompi({ 'psp-A': new Error('red'), 'psp-B': { status: 'VOIDED' } }))
    expect(r).toMatchObject({ candidatas: 2, errores: 1, cerradasExito: 1 })
    expect(s.reportar).toHaveBeenCalledTimes(1)
  })

  it('alreadyProcessed → yaCerradas sin warn', async () => {
    const { r, log } = await correr([transaccion()], wompi({ status: 'VOIDED' }), saleor({ alreadyProcessed: true }))
    expect(r).toMatchObject({ yaCerradas: 1, cerradasExito: 0 })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('errors INCORRECT_DETAILS → errores 1 y log fatal', async () => {
    const s = saleor({ errors: [{ field: null, message: 'x', code: 'INCORRECT_DETAILS' }] })
    const { r, log } = await correr([transaccion()], wompi({ status: 'VOIDED' }), s)
    expect(r.errores).toBe(1)
    expect(log.fatal).toHaveBeenCalledTimes(1)
  })

  it('importe de Wompi distinto → se reporta con el del request y hay warn', async () => {
    const { s, log } = await correr([transaccion()], wompi({ status: 'VOIDED', amount_in_cents: 5000000 }))
    expect(s.reportar).toHaveBeenCalledWith(expect.objectContaining({ amount: 120000 }))
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ importeCop: 120000, importeWompiCop: 50000 }),
      expect.stringContaining('difiere'),
    )
  })

  it('el tope de páginas se avisa por log', async () => {
    const log = crearLog()
    await conciliarSolicitudesPendientes({
      saleorLector: {
        listarTransaccionesConSolicitud: vi.fn(async ({ alLlegarAlTope }) => {
          alLlegarAlTope?.()
          return []
        }),
      },
      saleor: saleor(), politica: politicaAnulaciones(wompi({})), ventana: VENTANA, ahora: AHORA, log,
    })
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('tope de páginas'))
  })
})
