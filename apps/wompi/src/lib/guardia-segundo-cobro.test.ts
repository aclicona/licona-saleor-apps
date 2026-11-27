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
import { WompiHttpError } from './wompi-error.js'

const AHORA = new Date('2026-11-27T12:00:00Z')
const MIN = 60_000
const TTL = 30 * MIN
const CHECKOUT = Buffer.from('Checkout:1').toString('base64')
const MIA = 'mia'
const hace = (ms: number) => new Date(AHORA.getTime() - ms).toISOString()

const APP = 'QXBwOjE='
const NUESTRA_APP = { __typename: 'App', id: APP }
const OTRA_APP = { __typename: 'App', id: 'QXBwOjI=' }
const USUARIO = { __typename: 'User' }
const txn = (id: string, edadMs: number, extra: Partial<TransaccionDeCheckout> = {}): TransaccionDeCheckout => ({
  id,
  pspReference: `psp-${id}`,
  createdAt: hace(edadMs),
  createdBy: NUESTRA_APP,
  events: [],
  ...extra,
})
const evento = (type: string, pspReference = '', createdBy: TransaccionDeCheckout['createdBy'] = NUESTRA_APP) => ({ type, pspReference, createdBy })
/** Lo que deja en Saleor un rechazo respondido por esta App: sin pspReference en ningún sitio. */
const rechazada = (id: string, edadMs: number) => txn(id, edadMs, { pspReference: '', events: [evento('CHARGE_FAILURE')] })
/** «Failed to delivery request.»: el fallo lo crea Saleor, sin autor. */
const sinEntrega = (id: string, edadMs: number) => txn(id, edadMs, { pspReference: '', events: [evento('CHARGE_FAILURE', '', null)] })
const respuesta = (transacciones: TransaccionDeCheckout[], extra: Record<string, unknown> = {}) => ({
  appId: APP,
  transacciones,
  erroresParciales: [],
  ...extra,
})
const wompiTxn = (status: string) => ({ id: 'w', status }) as unknown as WompiTransaction

const getTransaction = vi.fn()
const findTransactionsByReference = vi.fn()
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function conSaleor(...transacciones: TransaccionDeCheckout[]) {
  vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue(respuesta([txn(MIA, 0, { pspReference: '' }), ...transacciones]))
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
  vi.restoreAllMocks()
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
  const seleccionar = (transacciones: TransaccionDeCheckout[], appId: string | undefined = APP) =>
    seleccionarCandidatas(transacciones, { miId: MIA, appId, ahora: AHORA, ttlMs: TTL })
  const ids = (r: { candidatas: TransaccionDeCheckout[] }) => r.candidatas.map((t) => t.id)

  it('excluye la propia, las cobradas, las falladas y las vencidas', () => {
    const cobrada = txn('ok', MIN, { events: [evento('CHARGE_SUCCESS', 'p')] })
    const fallida = txn('ko', MIN, { events: [evento('CHARGE_FAILURE', 'p', null)] })

    const r = seleccionar([txn(MIA, 0), cobrada, fallida, rechazada('rechazo', MIN), sinEntrega('sin-entrega', MIN), txn('vieja', TTL)])

    expect(ids(r)).toEqual(['sin-entrega'])
    expect(r.vencidas.map((t) => t.id)).toEqual(['vieja'])
  })

  it('un fallo sin pspReference creado por otro autor no es final', () => {
    const deOtra = txn('otra-app', MIN, { events: [evento('CHARGE_FAILURE', '', OTRA_APP)] })
    const deUsuario = txn('usuario', 2 * MIN, { events: [evento('CHARGE_FAILURE', '', USUARIO)] })
    expect(ids(seleccionar([deOtra, deUsuario]))).toEqual(['otra-app', 'usuario'])
  })

  it('descarta las transacciones de otra app o de un usuario; sin autor conocido se quedan', () => {
    const r = seleccionar([
      txn('nuestra', MIN),
      txn('ajena', 2 * MIN, { createdBy: OTRA_APP }),
      txn('manual', 3 * MIN, { createdBy: USUARIO }),
      txn('anonima', 4 * MIN, { createdBy: null }),
    ])
    expect(ids(r)).toEqual(['nuestra', 'anonima'])
  })

  it('sin appId no filtra por autor y el fallo de cualquier App es final', () => {
    const r = seleccionarCandidatas(
      [txn('ajena', MIN, { createdBy: OTRA_APP }), txn('manual', 2 * MIN, { createdBy: USUARIO }), rechazada('rechazo', MIN)],
      { miId: MIA, appId: undefined, ahora: AHORA, ttlMs: TTL },
    )
    expect(ids(r)).toEqual(['ajena', 'manual'])
  })

  it('deja solo las 5 más recientes, sin mutar la entrada', () => {
    const entrada = [7, 2, 5, 1, 6, 3, 4].map((n) => txn(`t${n}`, n * MIN))
    const copia = [...entrada]

    expect(ids(seleccionar(entrada))).toEqual(['t1', 't2', 't3', 't4', 't5'])
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
    conSaleor(txn('otra', MIN, { events: [evento('CHARGE_FAILURE', 'psp-otra')] }))
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
    vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue(
      respuesta([txn(MIA, 8_000, { pspReference: '' }), txn('otra', 2_000, { pspReference: '' })]),
    )
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
    vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue(respuesta([txn(MIA, MIN)]))
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

  it('6 rechazos de la App no tapan un PENDING más antiguo', async () => {
    conSaleor(...[1, 2, 3, 4, 5, 6].map((n) => rechazada(`r${n}`, n * MIN)), txn('pendiente', 10 * MIN))
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(getTransaction).toHaveBeenCalledWith('psp-pendiente', expect.any(AbortSignal))
    expect(findTransactionsByReference).not.toHaveBeenCalled()
  })

  it('un rechazo de la App de hace 5 s no bloquea el reintento', async () => {
    conSaleor(rechazada('r', 5_000))
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(findTransactionsByReference).not.toHaveBeenCalled()
  })

  it('un fallo de entrega de Saleor (sin autor) de hace 5 s sigue siendo candidata', async () => {
    conSaleor(sinEntrega('s', 5_000))
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(findTransactionsByReference).toHaveBeenCalledWith('s', expect.any(AbortSignal))
  })

  it('un rechazo de la App anterior a un cobro con la misma clave no esconde ese cobro', async () => {
    conSaleor(
      txn('reintentada', MIN, {
        pspReference: 'w1',
        events: [evento('CHARGE_FAILURE'), evento('CHARGE_ACTION_REQUIRED', 'w1')],
      }),
    )
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(getTransaction).toHaveBeenCalledWith('w1', expect.any(AbortSignal))
  })

  it('un fallo de la App tras un inicio de estado desconocido no es final: decide Wompi por reference', async () => {
    conSaleor(
      txn('ambigua', MIN, {
        pspReference: '',
        events: [evento('CHARGE_ACTION_REQUIRED'), evento('CHARGE_FAILURE')],
      }),
    )
    findTransactionsByReference.mockResolvedValue([wompiTxn('PENDING')])
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(findTransactionsByReference).toHaveBeenCalledWith('ambigua', expect.any(AbortSignal))
  })

  it('con solo un fallo de la App y ningún indicio de cobro no es candidata', async () => {
    conSaleor(txn('solo-rechazo', MIN, { pspReference: '', events: [evento('CHARGE_FAILURE')] }))
    findTransactionsByReference.mockResolvedValue([wompiTxn('PENDING')])
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(findTransactionsByReference).not.toHaveBeenCalled()
  })

  it('una transacción de otra app no se consulta en Wompi', async () => {
    conSaleor(txn('ajena', MIN, { createdBy: OTRA_APP }))
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it('404 de getTransaction es «sin rastro», no un fallo', async () => {
    conSaleor(txn('otra', MIN))
    getTransaction.mockRejectedValue(new WompiHttpError('Wompi 404', 404))
    expect(await comprobar()).toEqual({ bloquear: false })
    expect(log.error).not.toHaveBeenCalled()
  })

  it.each([401, 429, 500])('un %d de getTransaction sigue bloqueando', async (status) => {
    conSaleor(txn('otra', MIN))
    getTransaction.mockRejectedValue(new WompiHttpError('Wompi', status))
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_SIN_COMPROBAR })
  })

  it('la fase de Wompi tiene tope propio de 4 s y deja restanteMs al salir', async () => {
    const tope = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(tope.signal)
    conSaleor(txn('otra', MIN))
    getTransaction.mockImplementation(
      (_id: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abortada')))
          tope.abort()
        }),
    )

    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_SIN_COMPROBAR })
    expect(timeout).toHaveBeenCalledWith(4_000)
    expect(log.warn).toHaveBeenLastCalledWith(expect.objectContaining({ restanteMs: 12_000 }), expect.any(String))
  })

  it('el plazo global también corta la fase de Wompi', async () => {
    const plazo = new AbortController()
    conSaleor(txn('otra', MIN))
    getTransaction.mockImplementation(
      (_id: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abortada')))
          plazo.abort()
        }),
    )
    const r = await comprobarSegundoCobro({
      checkoutId: CHECKOUT,
      transactionId: MIA,
      wompi: { getTransaction, findTransactionsByReference },
      signal: plazo.signal,
      restanteMs: () => 0,
      log,
    })
    expect(r).toEqual({ bloquear: true, message: MENSAJE_SIN_COMPROBAR })
  })

  it('los errores parciales de Saleor se registran y la guardia sigue', async () => {
    vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue(
      respuesta([txn('otra', MIN, { createdBy: null })], { erroresParciales: ['createdBy falló'] }),
    )
    expect(await comprobar()).toEqual({ bloquear: true, message: MENSAJE_PAGO_EN_CURSO })
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ erroresParciales: ['createdBy falló'] }), expect.any(String))
  })

  it('los mensajes hacia Saleor son fijos', () => {
    expect(MENSAJE_PAGO_EN_CURSO).toBe('Ya hay un pago en curso para este carrito')
    expect(MENSAJE_SIN_COMPROBAR).toBe('No se pudo comprobar un pago anterior; reintente')
  })
})
