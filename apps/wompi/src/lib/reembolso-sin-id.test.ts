import { describe, it, expect, vi } from 'vitest'
import { conciliarSolicitudesPendientes, politicaReembolsos } from './conciliacion-solicitudes.js'
import type { ReportadorSaleor } from './conciliacion.js'
import type { EventoTransaccionSaleor, TransaccionConSolicitudes } from './saleor-client.js'
import type { WompiRefund, WompiTransaction } from './wompi-client.js'
import { refundsEmbebidos } from './refunds-embebidos.js'
import { PLAZO_GLOBAL_MS } from './plazo.js'
import { WompiHttpError } from './wompi-error.js'

/** Casado de reembolsos sin id contra `refunds[]` de GET /transactions/{psp} (B-1097, ruling de Fable). */

const AHORA = new Date('2026-10-09T12:00:00Z')
const VENTANA = { desde: new Date('2026-10-08T12:00:00Z'), hasta: AHORA }
const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000)
const SIN_ID = 'tx-1:reembolso-sin-id:abc-123'
const SIN_ID_2 = 'tx-1:reembolso-sin-id:def-456'
const CREADA = hace(10)
const CENTS = 5000000 // 50000 COP

const crearLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() })
const saleor = (): ReportadorSaleor => ({
  reportar: vi.fn().mockResolvedValue({ alreadyProcessed: false, transactionId: 'T1', errors: [] }),
})

const ev = (p: Partial<EventoTransaccionSaleor> = {}): EventoTransaccionSaleor => ({
  type: 'REFUND_REQUEST', pspReference: SIN_ID, createdAt: CREADA.toISOString(), amount: 50000, ...p,
})
const tx = (events: EventoTransaccionSaleor[] = [ev()]): TransaccionConSolicitudes => ({
  id: 'T1', cancelPendingAmount: 0, refundPendingAmount: 50000, events,
})
/** Item embebido de Wompi: sin `id`. `created_at` a `minDesdeCreada` minutos del request. */
const item = (minDesdeCreada: number, p: Record<string, unknown> = {}) => ({
  created_at: new Date(CREADA.getTime() + minDesdeCreada * 60_000).toISOString(),
  transaction_id: 'tx-1', status: 'APPROVED', amount_in_cents: CENTS, status_message: null, ...p,
})

function wompi(opts: {
  refunds?: unknown
  txError?: Error
  conocidos?: Record<string, Partial<WompiRefund> | Error>
}) {
  return {
    getTransaction: vi.fn(async (id: string): Promise<WompiTransaction> => {
      if (opts.txError) throw opts.txError
      return {
        id, status: 'APPROVED', reference: 'r', amount_in_cents: 10000000, currency: 'COP',
        payment_method_type: 'CARD', refunds: opts.refunds,
      }
    }),
    getRefund: vi.fn(async (id: string) => {
      const c = opts.conocidos?.[id]
      if (!c) throw new WompiHttpError('Wompi getRefund 404', 404)
      if (c instanceof Error) throw c
      return { id, transaction_id: 'tx-1', status: 'APPROVED', amount_in_cents: CENTS, ...c } as WompiRefund
    }),
  }
}

/** Eventos *_SUCCESS / *_FAILURE reportados: lo «sin decidir» nunca cierra (el INFO de aviso, B-1098, no cuenta). */
function cierres(s: ReportadorSaleor): string[] {
  return (s.reportar as ReturnType<typeof vi.fn>).mock.calls
    .map(([p]) => p.type as string)
    .filter((t) => /_(SUCCESS|FAILURE)$/.test(t))
}

async function correr(t: TransaccionConSolicitudes, w: ReturnType<typeof wompi>) {
  const s = saleor()
  const log = crearLog()
  const r = await conciliarSolicitudesPendientes({
    saleorLector: { listarTransaccionesConSolicitud: vi.fn().mockResolvedValue([t]) },
    saleor: s, politica: politicaReembolsos(w), ventana: VENTANA, ahora: AHORA, log,
  })
  return { r, s, log, w }
}

describe('reembolsos sin id: casado contra refunds[] de la transacción (B-1097)', () => {
  it('1 candidato APPROVED → REFUND_SUCCESS con el psp sin-id y el importe del request, y warn de auditoría', async () => {
    const { r, s, log, w } = await correr(tx(), wompi({ refunds: [item(0.1)] }))
    expect(w.getTransaction).toHaveBeenCalledWith('tx-1')
    expect(s.reportar).toHaveBeenCalledWith({
      transactionId: 'T1', type: 'REFUND_SUCCESS', amount: 50000, pspReference: SIN_ID,
      message: 'Wompi: reembolso confirmado (APPROVED); casado por importe y fecha, sin id',
    })
    expect(r).toMatchObject({ cerradasExito: 1, errores: 0, sinDecidir: 0 })
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ casadoSinId: expect.objectContaining({ createdAt: item(0.1).created_at, idsExcluidos: [] }) }),
      expect.any(String),
    )
  })

  it.each(['DECLINED', 'ERROR', 'VOIDED'])('%s → REFUND_FAILURE con mensaje fijo, nunca status_message', async (status) => {
    const { s } = await correr(tx(), wompi({ refunds: [item(0.1, { status, status_message: 'texto interno' })] }))
    expect(s.reportar).toHaveBeenCalledWith(expect.objectContaining({
      type: 'REFUND_FAILURE', pspReference: SIN_ID, amount: 50000,
      message: `Wompi no aprobó el reembolso (${status}); casado por importe y fecha, sin id`,
    }))
    expect(JSON.stringify((s.reportar as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('texto interno')
  })

  it('PENDING dentro del margen → esperar; PENDING vencido → sin-decidir', async () => {
    const dentro = await correr(tx(), wompi({ refunds: [item(0.1, { status: 'PENDING' })] }))
    expect(dentro.r).toMatchObject({ enEspera: 1, sinDecidir: 0 })
    expect(cierres(dentro.s)).toEqual([])

    const vencida = tx([ev({ createdAt: hace(61).toISOString() })])
    const w = wompi({ refunds: [{ ...item(0), created_at: hace(61).toISOString(), status: 'PENDING' }] })
    const fuera = await correr(vencida, w)
    expect(fuera.r).toMatchObject({ enEspera: 0, sinDecidir: 1, cerradasFallo: 0 })
    expect(cierres(fuera.s)).toEqual([])
  })

  it('estado desconocido → sin-decidir', async () => {
    const { r, s } = await correr(tx(), wompi({ refunds: [item(0.1, { status: 'RARO' })] }))
    expect(r.sinDecidir).toBe(1)
    expect(cierres(s)).toEqual([])
  })

  it('0 candidatos: dentro del margen → esperar; vencido → sin-decidir (nunca fallo)', async () => {
    const dentro = await correr(tx(), wompi({ refunds: [] }))
    expect(dentro.r).toMatchObject({ enEspera: 1, sinDecidir: 0, cerradasFallo: 0 })

    const vencida = tx([ev({ createdAt: hace(61).toISOString() })])
    const fuera = await correr(vencida, wompi({ refunds: [] }))
    expect(fuera.r).toMatchObject({ enEspera: 0, sinDecidir: 1, cerradasFallo: 0 })
    expect(cierres(fuera.s)).toEqual([])
  })

  it('refunds ausente o no-array cuenta como 0 candidatos', async () => {
    expect((await correr(tx(), wompi({}))).r.enEspera).toBe(1)
    expect((await correr(tx(), wompi({ refunds: 'raro' }))).r.enEspera).toBe(1)
  })

  it('> 1 candidato → sin-decidir de inmediato', async () => {
    const { r, s } = await correr(tx(), wompi({ refunds: [item(0.1), item(0.5)] }))
    expect(r).toMatchObject({ sinDecidir: 1, cerradasExito: 0 })
    expect(cierres(s)).toEqual([])
  })

  it('conocido (con id) excluido por created_at exacto deja 1 candidato', async () => {
    const propio = item(1)
    const ajeno = item(0.1)
    const t = tx([ev(), ev({ pspReference: '777' }), ev({ type: 'REFUND_SUCCESS', pspReference: '777' })])
    const w = wompi({ refunds: [ajeno, propio], conocidos: { '777': { created_at: ajeno.created_at } } })
    const { r, s, log } = await correr(t, w)
    expect(w.getRefund).toHaveBeenCalledTimes(1) // deduplicado: 777 aparece en 2 eventos
    expect(s.reportar).toHaveBeenCalledWith(expect.objectContaining({ type: 'REFUND_SUCCESS', pspReference: SIN_ID }))
    expect(r.cerradasExito).toBe(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ casadoSinId: expect.objectContaining({ createdAt: propio.created_at, idsExcluidos: ['777'] }) }),
      expect.any(String),
    )
  })

  it('conocido de otro importe no se consulta ni excluye', async () => {
    const t = tx([ev(), ev({ type: 'REFUND_SUCCESS', pspReference: '888', amount: 1000 })])
    const w = wompi({ refunds: [item(0.1)] })
    const { r } = await correr(t, w)
    expect(w.getRefund).not.toHaveBeenCalled()
    expect(r.cerradasExito).toBe(1)
  })

  it.each([
    ['404', new WompiHttpError('Wompi getRefund 404', 404)],
    ['500', new WompiHttpError('Wompi getRefund 500', 500)],
  ])('conocido no consultable (%s) → sin-decidir CONOCIDO_NO_CONSULTABLE, sin contar por número', async (_n, error) => {
    const t = tx([ev(), ev({ type: 'REFUND_SUCCESS', pspReference: '777' })])
    const w = wompi({ refunds: [item(0.1)], conocidos: { '777': error } })
    const { r, s, log } = await correr(t, w)
    expect(r).toMatchObject({ sinDecidir: 1, errores: 0 })
    expect(cierres(s)).toEqual([])
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ estadoWompi: 'CONOCIDO_NO_CONSULTABLE' }), expect.any(String))
  })

  describe('otro sin-id del mismo importe ya cerrado (revisión pre-merge)', () => {
    const cerrado = (psp: string, creadaMin: number) => [
      ev({ pspReference: psp, createdAt: hace(creadaMin).toISOString() }),
      ev({ type: 'REFUND_SUCCESS', pspReference: psp, createdAt: hace(1).toISOString() }),
    ]

    it('B (abierto) con ventana solapada con la de A (ya SUCCESS) → sin-decidir sin consultar Wompi', async () => {
      // A se casó con R1 y quedó SUCCESS; B nunca creó su reembolso, pero R1 cae en su ventana.
      const t = tx([ev(), ...cerrado(SIN_ID_2, 10.5)])
      const w = wompi({ refunds: [item(0.1)] })
      const { r, s } = await correr(t, w)
      expect(r).toMatchObject({ sinDecidir: 1, cerradasExito: 0 })
      expect(w.getTransaction).not.toHaveBeenCalled()
      expect(w.getRefund).not.toHaveBeenCalled()
      expect(cierres(s)).toEqual([])
    })

    it('el otro sin-id sin REFUND_REQUEST visible (solo SUCCESS) se trata como solapado', async () => {
      const t = tx([ev(), ev({ type: 'REFUND_SUCCESS', pspReference: SIN_ID_2 })])
      const { r } = await correr(t, wompi({ refunds: [item(0.1)] }))
      expect(r.sinDecidir).toBe(1)
    })

    it('ventanas que no se solapan, o de otro importe → se casa normalmente', async () => {
      const lejos = tx([ev(), ...cerrado(SIN_ID_2, 600)])
      expect((await correr(lejos, wompi({ refunds: [item(0.1)] }))).r.cerradasExito).toBe(1)

      const otroImporte = tx([ev(), ev({ pspReference: SIN_ID_2, amount: 1000 }), ev({ type: 'REFUND_SUCCESS', pspReference: SIN_ID_2, amount: 1000 })])
      expect((await correr(otroImporte, wompi({ refunds: [item(0.1)] }))).r.cerradasExito).toBe(1)
    })
  })

  it('REFUND_REVERSE no cuenta como conocido', async () => {
    const t = tx([ev(), ev({ type: 'REFUND_REVERSE', pspReference: '999' })])
    const w = wompi({ refunds: [item(0.1)] })
    const { r } = await correr(t, w)
    expect(w.getRefund).not.toHaveBeenCalled()
    expect(r.cerradasExito).toBe(1)
  })

  it('≥ 2 requests sin-id abiertos del mismo importe → todos sin-decidir sin llamar a Wompi', async () => {
    const t = tx([ev(), ev({ pspReference: SIN_ID_2 })])
    const w = wompi({ refunds: [item(0.1)] })
    const { r, s } = await correr(t, w)
    expect(r.sinDecidir).toBe(2)
    expect(w.getTransaction).not.toHaveBeenCalled()
    expect(w.getRefund).not.toHaveBeenCalled()
    expect(cierres(s)).toEqual([])
  })

  it('un sin-id de otro importe no genera ambigüedad', async () => {
    const t = tx([ev(), ev({ pspReference: SIN_ID_2, amount: 1000 })])
    const { r } = await correr(t, wompi({ refunds: [item(0.1)] }))
    expect(r.cerradasExito).toBe(1)
  })

  it('created_at fuera de ventana o no parseable, o importe distinto, no cuenta', async () => {
    const margen = 2 + PLAZO_GLOBAL_MS / 60_000
    const refunds = [
      item(-2.1), item(margen + 0.1), item(0.1, { created_at: 'no-es-fecha' }),
      item(0.1, { amount_in_cents: CENTS + 100 }),
    ]
    const { r, s } = await correr(tx(), wompi({ refunds }))
    expect(r).toMatchObject({ enEspera: 1, cerradasExito: 0 })
    expect(cierres(s)).toEqual([])
  })

  it('los bordes de la ventana sí cuentan', async () => {
    expect((await correr(tx(), wompi({ refunds: [item(-2)] }))).r.cerradasExito).toBe(1)
    expect((await correr(tx(), wompi({ refunds: [item(2 + PLAZO_GLOBAL_MS / 60_000)] }))).r.cerradasExito).toBe(1)
  })

  it('un item mal formado no cuenta (no lanza)', async () => {
    const refunds = [null, 'x', 7, {}, item(0.1, { amount_in_cents: 'mucho' }), item(0.1, { status: 5 })]
    const { r } = await correr(tx(), wompi({ refunds }))
    expect(r).toMatchObject({ enEspera: 1, errores: 0 })
  })

  it('GET transacción 404 → sin-decidir HTTP_404; 500 → error propagado (errores 1)', async () => {
    const a = await correr(tx(), wompi({ txError: new WompiHttpError('Wompi 404', 404) }))
    expect(a.r).toMatchObject({ sinDecidir: 1, errores: 0 })
    expect(a.log.error).toHaveBeenCalledWith(expect.objectContaining({ estadoWompi: 'HTTP_404' }), expect.any(String))

    const b = await correr(tx(), wompi({ txError: new WompiHttpError('Wompi 500', 500) }))
    expect(b.r).toMatchObject({ errores: 1, sinDecidir: 0 })
    expect(cierres(b.s)).toEqual([])
  })
})

describe('refundsEmbebidos', () => {
  it('valida la forma y descarta items inválidos', () => {
    const ok = item(0)
    const r = refundsEmbebidos({ refunds: [ok, null, { ...ok, created_at: 'x' }, { ...ok, amount_in_cents: 1.5 }] })
    expect(r).toEqual([{ creadoMs: Date.parse(ok.created_at), amountInCents: CENTS, status: 'APPROVED' }])
  })
  it('sin refunds o no-array → []', () => {
    expect(refundsEmbebidos({})).toEqual([])
    expect(refundsEmbebidos({ refunds: {} })).toEqual([])
  })
})
