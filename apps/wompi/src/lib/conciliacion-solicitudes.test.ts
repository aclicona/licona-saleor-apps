import { describe, it, expect, vi } from 'vitest'
import {
  conciliarSolicitudesPendientes,
  politicaAnulaciones,
  politicaReembolsos,
  solicitudesSinResolver,
  type LectorSolicitudesSaleor,
} from './conciliacion-solicitudes.js'
import type { ReportadorSaleor } from './conciliacion.js'
import type { EventoTransaccionSaleor, TransaccionConSolicitudes } from './saleor-client.js'
import type { WompiRefund, WompiTransaction } from './wompi-client.js'
import { WompiHttpError } from './wompi-error.js'

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

/** Eventos *_SUCCESS / *_FAILURE reportados: lo «sin decidir» nunca cierra la solicitud (el INFO de aviso no cuenta). */
function cierres(s: ReportadorSaleor): string[] {
  return (s.reportar as ReturnType<typeof vi.fn>).mock.calls
    .map(([p]) => p.type as string)
    .filter((t) => /_(SUCCESS|FAILURE)$/.test(t))
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
    expect(cierres(s)).toEqual([])
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
    expect(cierres(s)).toEqual([])
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

describe('conciliarSolicitudesPendientes (reembolsos, B-1077)', () => {
  const reqReembolso = (parcial: Partial<EventoTransaccionSaleor> = {}) =>
    evento({ type: 'REFUND_REQUEST', pspReference: '4567', amount: 50000, ...parcial })
  const txR = (parcial: Partial<TransaccionConSolicitudes> = {}) =>
    transaccion({ cancelPendingAmount: 0, refundPendingAmount: 50000, events: [reqReembolso()], ...parcial })

  function wompiR(r: Partial<WompiRefund> | Error) {
    return {
      getTransaction: vi.fn(async (): Promise<WompiTransaction> => {
        throw new Error('el caso con id no consulta la transacción')
      }),
      getRefund: vi.fn(async (id: string) => {
        if (r instanceof Error) throw r
        return { id, transaction_id: 'tx', status: 'APPROVED', amount_in_cents: 5000000, ...r } as WompiRefund
      }),
    }
  }

  async function correrR(ts: TransaccionConSolicitudes[], w: ReturnType<typeof wompiR>, s = saleor(), log = crearLog()) {
    const r = await conciliarSolicitudesPendientes({
      saleorLector: lector(ts), saleor: s, politica: politicaReembolsos(w), ventana: VENTANA, ahora: AHORA, log,
    })
    return { r, s, log }
  }

  it('APPROVED → REFUND_SUCCESS con el psp y el importe del request', async () => {
    const { r, s, log } = await correrR([txR()], wompiR({ status: 'APPROVED' }))
    expect(s.reportar).toHaveBeenCalledWith({
      transactionId: 'T1', type: 'REFUND_SUCCESS', amount: 50000, pspReference: '4567', message: 'Wompi: reembolso confirmado (APPROVED)',
    })
    expect(r).toMatchObject({ candidatas: 1, cerradasExito: 1, errores: 0 })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it.each(['DECLINED', 'ERROR', 'VOIDED'] as const)('%s → REFUND_FAILURE con mensaje fijo, sin status_message de Wompi', async (status) => {
    const { r, s } = await correrR([txR()], wompiR({ status, status_message: 'texto interno de Wompi' }))
    expect(s.reportar).toHaveBeenCalledWith({
      transactionId: 'T1', type: 'REFUND_FAILURE', amount: 50000, pspReference: '4567', message: `Wompi no aprobó el reembolso (${status})`,
    })
    expect(JSON.stringify((s.reportar as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('texto interno')
    expect(r.cerradasFallo).toBe(1)
  })

  it('PENDING dentro del margen → en espera; vencido → sin decidir (no fallo)', async () => {
    const dentro = await correrR([txR()], wompiR({ status: 'PENDING' }))
    expect(dentro.r).toMatchObject({ enEspera: 1, sinDecidir: 0 })
    expect(dentro.s.reportar).not.toHaveBeenCalled()

    const vencido = txR({ events: [reqReembolso({ createdAt: hace(61) })] })
    const fuera = await correrR([vencido], wompiR({ status: 'PENDING' }))
    expect(fuera.r).toMatchObject({ enEspera: 0, sinDecidir: 1, cerradasFallo: 0 })
    expect(cierres(fuera.s)).toEqual([])
    expect(fuera.log.error).toHaveBeenCalledWith(expect.objectContaining({ estadoWompi: 'PENDING' }), expect.any(String))
  })

  it('estado desconocido → sin decidir', async () => {
    const { r, s } = await correrR([txR()], wompiR({ status: 'RARO' }))
    expect(r.sinDecidir).toBe(1)
    expect(cierres(s)).toEqual([])
  })

  it('404 → sin decidir sin contar error; 500 → errores 1', async () => {
    const a = await correrR([txR()], wompiR(new WompiHttpError('Wompi getRefund 404', 404)))
    expect(a.r).toMatchObject({ sinDecidir: 1, errores: 0 })
    expect(a.log.error).toHaveBeenCalledWith(expect.objectContaining({ estadoWompi: 'HTTP_404' }), expect.any(String))

    const b = await correrR([txR()], wompiR(new WompiHttpError('Wompi getRefund 500', 500)))
    expect(b.r).toMatchObject({ errores: 1, sinDecidir: 0 })
    expect(b.s.reportar).not.toHaveBeenCalled()
  })

  // El caso «psp sin id» se cubre en reembolso-sin-id.test.ts (B-1097).

  it('refundPendingAmount 0 → no consulta; con un request ya cerrado solo cierra el abierto', async () => {
    const w = wompiR({ status: 'APPROVED' })
    const cero = await correrR([txR({ refundPendingAmount: 0 })], w)
    expect(cero.r.candidatas).toBe(0)
    expect(w.getRefund).not.toHaveBeenCalled()

    const t = txR({
      events: [
        reqReembolso({ pspReference: '111' }),
        reqReembolso({ type: 'REFUND_SUCCESS', pspReference: '111' }),
        reqReembolso({ pspReference: '222' }),
      ],
    })
    const { s } = await correrR([t], w)
    expect(s.reportar).toHaveBeenCalledTimes(1)
    expect(s.reportar).toHaveBeenCalledWith(expect.objectContaining({ pspReference: '222', type: 'REFUND_SUCCESS' }))
  })

  it('importe de Wompi distinto → se reporta con el del request y hay warn', async () => {
    const { s, log } = await correrR([txR()], wompiR({ status: 'APPROVED', amount_in_cents: 2000000 }))
    expect(s.reportar).toHaveBeenCalledWith(expect.objectContaining({ amount: 50000 }))
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ importeCop: 50000, importeWompiCop: 20000 }),
      expect.stringContaining('difiere'),
    )
  })

  it('alreadyProcessed → yaCerradas sin warn ni doble conteo', async () => {
    const { r, log } = await correrR([txR()], wompiR({ status: 'APPROVED' }), saleor({ alreadyProcessed: true }))
    expect(r).toMatchObject({ yaCerradas: 1, cerradasExito: 0, cerradasFallo: 0 })
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('B-1098: aviso INFO de lo sin decidir', () => {
  const sinDecidir = () => wompi({ status: 'DECLINED' })
  const clave = 'revision-humana:CANCEL_REQUEST:estado-inesperado:psp-A'
  const reportes = (s: ReportadorSaleor) => (s.reportar as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => p)

  it('sin-decidir → un INFO con la clave, el importe de la solicitud y sin availableActions', async () => {
    const { s, log } = await correr([transaccion()], sinDecidir())
    expect(s.reportar).toHaveBeenCalledTimes(1)
    const [p] = reportes(s)
    expect(p).toMatchObject({ transactionId: 'T1', type: 'INFO', pspReference: clave, amount: 120000 })
    expect(p.availableActions).toBeUndefined()
    expect(p.message).toBe('Revisión humana: anulación sin resolver en Wompi (estado-inesperado). Este aviso no mueve dinero; ver logs de app-wompi')
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('si los eventos ya contienen ese INFO no se reporta, pero el log.error con marcador sí se emite', async () => {
    const t = transaccion({ events: [evento(), evento({ type: 'INFO', pspReference: clave })] })
    const { s, log, r } = await correr([t], sinDecidir())
    expect(s.reportar).not.toHaveBeenCalled()
    expect(r.sinDecidir).toBe(1)
    expect(log.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/revisión humana/i))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('caso B (pendiente sin request abierto) → clave con sin-request-abierto y el transactionId', async () => {
    const t = transaccion({ events: [evento(), evento({ type: 'CANCEL_SUCCESS' })] })
    const { s } = await correr([t], sinDecidir())
    expect(reportes(s)).toEqual([
      expect.objectContaining({ type: 'INFO', amount: 120000, pspReference: 'revision-humana:CANCEL_REQUEST:sin-request-abierto:T1' }),
    ])
  })

  it.each([
    ['lanza', () => vi.fn().mockRejectedValue(new Error('red'))],
    ['devuelve errors', () => vi.fn().mockResolvedValue({ alreadyProcessed: false, transactionId: null, errors: [{ field: null, message: 'x', code: 'GRAPHQL_ERROR' }] })],
  ])('si reportar %s → no propaga, avisa con warn, no cuenta error y sigue con la siguiente', async (_n, mk) => {
    const s: ReportadorSaleor = { reportar: mk() }
    const t2 = transaccion({ id: 'T2', events: [evento({ pspReference: 'psp-Z' })] })
    const { r, log } = await correr([transaccion(), t2], sinDecidir(), s)
    expect(r).toMatchObject({ candidatas: 2, sinDecidir: 2, errores: 0 })
    expect(s.reportar).toHaveBeenCalledTimes(2)
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/La próxima corrida reintenta/))
  })

  it('otro motivo para el mismo psp → otra clave (y no la deduplica el INFO de otro motivo)', async () => {
    const previo = transaccion({ events: [evento(), evento({ type: 'INFO', pspReference: clave })] })
    const { s } = await correr([previo], wompi({ status: 'PENDING' }), saleor(), crearLog())
    // PENDING en anulaciones también es sin-decidir → motivo pendiente-vencido
    expect(reportes(s)[0].pspReference).toBe('revision-humana:CANCEL_REQUEST:pendiente-vencido:psp-A')
  })
})
