import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./saleor-client.js', () => ({ obtenerTransaccionesDelCheckout: vi.fn() }))

import { obtenerTransaccionesDelCheckout, type TransaccionDeCheckout } from './saleor-client.js'
import {
  MENSAJE_PAGO_EN_CURSO,
  MENSAJE_SIN_COMPROBAR,
  comprobarSegundoCobro,
  decidir,
  seleccionarCandidatas,
  ttlBloqueoMs,
} from './guardia-segundo-cobro.js'
import type { WompiTransaction } from './wompi-client.js'

const AHORA = new Date('2026-11-27T12:00:00Z')
const MIN = 60_000
const TTL = 30 * MIN
const CHECKOUT = Buffer.from('Checkout:1').toString('base64')
const MIA = 'mia'
const hace = (ms: number) => new Date(AHORA.getTime() - ms).toISOString()

const txn = (id: string, edadMs: number, extra: Partial<TransaccionDeCheckout> = {}): TransaccionDeCheckout => ({
  id,
  pspReference: `psp-${id}`,
  createdAt: hace(edadMs),
  chargedAmount: 0,
  events: [],
  ...extra,
})
const wompiTxn = (status: string) => ({ id: 'w', status }) as unknown as WompiTransaction

const getTransaction = vi.fn()
const findTransactionsByReference = vi.fn()
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function conSaleor(...transacciones: TransaccionDeCheckout[]) {
  vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue([txn(MIA, 0, { pspReference: '' }), ...transacciones])
}

const comprobar = (checkoutId: unknown = CHECKOUT) =>
  comprobarSegundoCobro({
    checkoutId,
    transactionId: MIA,
    wompi: { getTransaction, findTransactionsByReference },
    signal: new AbortController().signal,
    restanteMs: () => 12_000,
    log,
  })

beforeEach(() => {
  vi.useFakeTimers({ now: AHORA })
  vi.clearAllMocks()
  getTransaction.mockResolvedValue(wompiTxn('PENDING'))
  findTransactionsByReference.mockResolvedValue([])
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('ttlBloqueoMs', () => {
  it('por defecto son 30 minutos', () => {
    expect(ttlBloqueoMs({})).toBe(TTL)
  })

  it('respeta un entero positivo', () => {
    expect(ttlBloqueoMs({ WOMPI_BLOQUEO_PENDIENTE_MIN: '10' })).toBe(10 * MIN)
  })

  it.each(['', '0', '-5', '1.5', 'abc', '1e3', '10min'])('valor inválido %j cae a 30', (valor) => {
    expect(ttlBloqueoMs({ WOMPI_BLOQUEO_PENDIENTE_MIN: valor })).toBe(TTL)
  })
})

describe('seleccionarCandidatas', () => {
  it('excluye la propia, las cobradas, las falladas con pspReference y las vencidas', () => {
    const cobrada = txn('ok', MIN, { events: [{ type: 'CHARGE_SUCCESS', pspReference: 'p' }] })
    const fallida = txn('ko', MIN, { events: [{ type: 'CHARGE_FAILURE', pspReference: 'p' }] })
    const fallidaSinPsp = txn('ko-sin', MIN, { pspReference: '', events: [{ type: 'CHARGE_FAILURE', pspReference: '' }] })
    const vencida = txn('vieja', TTL)

    const { candidatas, vencidas } = seleccionarCandidatas([txn(MIA, 0), cobrada, fallida, fallidaSinPsp, vencida], MIA, AHORA, TTL)

    expect(candidatas.map((t) => t.id)).toEqual(['ko-sin'])
    expect(vencidas.map((t) => t.id)).toEqual(['vieja'])
  })

  it('deja solo las 5 más recientes, sin mutar la entrada', () => {
    const entrada = [7, 2, 5, 1, 6, 3, 4].map((n) => txn(`t${n}`, n * MIN))
    const copia = [...entrada]

    const { candidatas } = seleccionarCandidatas(entrada, MIA, AHORA, TTL)

    expect(candidatas.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(entrada).toEqual(copia)
  })
})

describe('decidir', () => {
  const mia = { id: 'm', createdAt: hace(1_000) }
  const sinRastro = (id: string, edadMs: number) => ({ candidata: txn(id, edadMs), consulta: { tipo: 'wompi' as const, estados: [] } })

  it('desempata por id cuando ambas nacieron en el mismo instante', () => {
    expect(decidir([sinRastro('a', 1_000)], mia, AHORA)).toBe('en_curso')
    expect(decidir([sinRastro('z', 1_000)], mia, AHORA)).toBe('proceder')
  })

  it('un pago vivo manda sobre una consulta fallida', () => {
    const fallida = { candidata: txn('a', MIN), consulta: { tipo: 'fallo' as const } }
    const viva = { candidata: txn('b', MIN), consulta: { tipo: 'wompi' as const, estados: ['PENDING'] } }
    expect(decidir([fallida, viva], mia, AHORA)).toBe('en_curso')
    expect(decidir([fallida], mia, AHORA)).toBe('sin_comprobar')
  })

  it('un estado que no es final de fallo bloquea (desconocido ≠ rechazo)', () => {
    const rara = { candidata: txn('a', MIN), consulta: { tipo: 'wompi' as const, estados: ['OTRO'] } }
    expect(decidir([rara], mia, AHORA)).toBe('en_curso')
  })
})

describe('comprobarSegundoCobro', () => {
  it('sin otras transacciones procede sin consultar Wompi', async () => {
    conSaleor()
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(getTransaction).not.toHaveBeenCalled()
    expect(findTransactionsByReference).not.toHaveBeenCalled()
  })

  it.each(['PENDING', 'APPROVED'])('%s en Wompi bloquea con el mensaje fijo', async (estado) => {
    conSaleor(txn('otra', MIN))
    getTransaction.mockResolvedValue(wompiTxn(estado))
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(getTransaction).toHaveBeenCalledWith('psp-otra', expect.any(AbortSignal))
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ restanteMs: 12_000 }), expect.any(String))
  })

  it.each(['DECLINED', 'ERROR', 'VOIDED'])('%s en Wompi procede', async (estado) => {
    conSaleor(txn('otra', MIN))
    getTransaction.mockResolvedValue(wompiTxn(estado))
    expect(await comprobar()).toEqual({ bloquear: false })
  })

  it('CHARGE_FAILURE con pspReference procede sin consultar', async () => {
    conSaleor(txn('otra', MIN, { events: [{ type: 'CHARGE_FAILURE', pspReference: 'psp-otra' }] }))
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it('una pendiente más vieja que el TTL procede con warn', async () => {
    conSaleor(txn('vieja', TTL + MIN))
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(getTransaction).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ vencidas: ['vieja'] }), expect.any(String))
  })

  it('el TTL sale de WOMPI_BLOQUEO_PENDIENTE_MIN', async () => {
    vi.stubEnv('WOMPI_BLOQUEO_PENDIENTE_MIN', '5')
    conSaleor(txn('otra', 6 * MIN))
    expect(await comprobar()).toEqual({ bloquear: false })
  })

  it('sin pspReference busca por reference y bloquea si está PENDING', async () => {
    conSaleor(txn('otra', MIN, { pspReference: '' }))
    findTransactionsByReference.mockResolvedValue([wompiTxn('PENDING')])
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(findTransactionsByReference).toHaveBeenCalledWith('otra', expect.any(AbortSignal))
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it('la reference respeta la codificación configurada', async () => {
    vi.stubEnv('WOMPI_REFERENCIA_CODIFICADA', 'true')
    conSaleor(txn('otra', MIN, { pspReference: '' }))
    await comprobar()
    expect(findTransactionsByReference).toHaveBeenCalledWith(Buffer.from('otra').toString('base64url'), expect.any(AbortSignal))
  })

  it('sin rastro en Wompi y con más de 30 s procede', async () => {
    conSaleor(txn('otra', 31_000, { pspReference: '' }))
    expect(await comprobar()).toEqual({ bloquear: false })
  })

  it('carrera: la candidata sin rastro es más antigua y reciente, la mía cede', async () => {
    conSaleor(txn('otra', 5_000, { pspReference: '' }))
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
  })

  it('carrera: la mía es la más antigua, procede', async () => {
    vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue([
      txn(MIA, 8_000, { pspReference: '' }),
      txn('otra', 2_000, { pspReference: '' }),
    ])
    expect(await comprobar()).toEqual({ bloquear: false })
  })

  it('si la consulta a Saleor falla, procede (fail-open) con log.error', async () => {
    vi.mocked(obtenerTransaccionesDelCheckout).mockRejectedValue(new Error('saleor caído'))
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ restanteMs: 12_000 }), expect.any(String))
  })

  it('si Wompi falla habiendo candidata, rechaza (fail-closed) sin texto del error', async () => {
    conSaleor(txn('otra', MIN))
    getTransaction.mockRejectedValue(new Error('secreto-interno'))
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_SIN_COMPROBAR })
    expect(log.error).toHaveBeenCalled()
  })

  it('ignora mi propia transacción', async () => {
    vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue([txn(MIA, MIN)])
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 42, Buffer.from('Order:1').toString('base64')])('sin id de Checkout (%j) no corre', async (id) => {
    expect(
      await comprobarSegundoCobro({
        checkoutId: id,
        transactionId: MIA,
        wompi: { getTransaction, findTransactionsByReference },
        signal: new AbortController().signal,
        restanteMs: () => 1,
        log,
      }),
    ).toEqual({ bloquear: false })
    expect(obtenerTransaccionesDelCheckout).not.toHaveBeenCalled()
  })

  it('con más de 5 candidatas consulta solo 5', async () => {
    conSaleor(...[1, 2, 3, 4, 5, 6, 7].map((n) => txn(`t${n}`, n * MIN)))
    getTransaction.mockResolvedValue(wompiTxn('DECLINED'))
    await comprobar()
    expect(getTransaction).toHaveBeenCalledTimes(5)
  })

  it('los mensajes hacia Saleor son fijos', () => {
    expect(MENSAJE_PAGO_EN_CURSO).toBe('Ya hay un pago en curso para este carrito')
    expect(MENSAJE_SIN_COMPROBAR).toBe('No se pudo comprobar un pago anterior; reintente')
  })
})
