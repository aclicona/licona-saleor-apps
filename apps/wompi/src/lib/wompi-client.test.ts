import { createHash } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WompiClient, TIMEOUT_WOMPI_MS } from './wompi-client.js'
import { WompiHttpError } from './wompi-error.js'

const PARAMS_CREAR = { amountInCents: 1000, currency: 'COP', customerEmail: 'a@b.co', reference: 'r', redirectUrl: 'https://x.co', acceptanceToken: 't' } as const

function crearClientePrueba() {
  return new WompiClient({
    publicKey: 'pub_test_key',
    privateKey: 'prv_test_key',
    integrityKey: 'test-integrity-key',
  })
}

describe('WompiClient.integritySignature — firma de integridad del cobro', () => {
  it('reproduce exactamente el hash sha256 documentado por Wompi (reference + amount_in_cents + currency + integrityKey)', () => {
    const client = crearClientePrueba()
    const firma = client.integritySignature('ref-123', 12000000, 'COP')

    const esperado = createHash('sha256')
      .update('ref-123' + 12000000 + 'COP' + 'test-integrity-key')
      .digest('hex')

    expect(firma).toBe(esperado)
  })

  it('es determinista: la misma entrada siempre produce la misma firma', () => {
    const client = crearClientePrueba()
    const firma1 = client.integritySignature('ref-abc', 500000, 'COP')
    const firma2 = client.integritySignature('ref-abc', 500000, 'COP')

    expect(firma1).toBe(firma2)
  })

  it('un centavo de diferencia en el monto cambia la firma (protege contra manipulación del monto)', () => {
    const client = crearClientePrueba()
    const firmaOriginal = client.integritySignature('ref-abc', 500000, 'COP')
    const firmaManipulada = client.integritySignature('ref-abc', 500001, 'COP')

    expect(firmaManipulada).not.toBe(firmaOriginal)
  })

  it('una referencia distinta produce una firma distinta (protege contra reutilizar la firma en otra transacción)', () => {
    const client = crearClientePrueba()
    const firmaA = client.integritySignature('ref-a', 500000, 'COP')
    const firmaB = client.integritySignature('ref-b', 500000, 'COP')

    expect(firmaA).not.toBe(firmaB)
  })

  it('una integrityKey distinta (otro merchant/comercio) produce una firma distinta', () => {
    const clienteA = new WompiClient({
      publicKey: 'pub',
      privateKey: 'prv',
      integrityKey: 'key-comercio-a',
    })
    const clienteB = new WompiClient({
      publicKey: 'pub',
      privateKey: 'prv',
      integrityKey: 'key-comercio-b',
    })

    const firmaA = clienteA.integritySignature('ref-abc', 500000, 'COP')
    const firmaB = clienteB.integritySignature('ref-abc', 500000, 'COP')

    expect(firmaA).not.toBe(firmaB)
  })

  it('siempre produce un hash sha256 en hexadecimal (64 caracteres)', () => {
    const client = crearClientePrueba()
    const firma = client.integritySignature('ref-abc', 500000, 'COP')

    expect(firma).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('WompiClient.listTransactions — consulta para la conciliación (B-412)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const pag = (ids: string[], meta?: Record<string, number>) => ({
    ok: true,
    json: () => Promise.resolve({ data: ids.map((id) => ({ id, created_at: '2026-10-02T10:00:00Z' })), ...(meta ? { meta } : {}) }),
  })
  const D = new Date('2026-10-01T00:00:00Z')
  const H = new Date('2026-10-02T12:00:00Z')

  it('autentica con la llave privada, filtra por created_at y envía page/page_size', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: 'a', created_at: '2026-10-02T10:00:00Z' }, { id: 'b', created_at: '2026-09-01T10:00:00Z' }],
        meta: { page: 1, page_size: 100, total_results: 2 },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await crearClientePrueba().listTransactions(D, H)
    expect(r.map((t) => t.id)).toEqual(['a'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/transactions?from_date=2026-10-01&until_date=2026-10-02&page=1&page_size=100')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer prv_test_key')
  })

  it('con la forma real de Wompi ({page, page_size, total_results}) lee todas las páginas', async () => {
    // Medido en el sandbox: 12 resultados con page_size 5 → páginas de 5, 5 y 2. Wompi NO envía total_pages.
    const llena = (n: number) => Array.from({ length: 5 }, (_, k) => `t${n}-${k}`)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pag(llena(1), { page: 1, page_size: 5, total_results: 12 }))
      .mockResolvedValueOnce(pag(llena(2), { page: 2, page_size: 5, total_results: 12 }))
      .mockResolvedValueOnce(pag(['t3-0', 't3-1'], { page: 3, page_size: 5, total_results: 12 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await crearClientePrueba().listTransactions(D, H)
    expect(r).toHaveLength(12)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('sin meta: sigue mientras la página venga llena y corta en la primera corta', async () => {
    const llena = Array.from({ length: 100 }, (_, k) => `x${k}`)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pag(llena))
      .mockResolvedValueOnce(pag(llena.map((i) => i + 'b')))
      .mockResolvedValueOnce(pag(['ultima']))
    vi.stubGlobal('fetch', fetchMock)
    const r = await crearClientePrueba().listTransactions(D, H)
    expect(r).toHaveLength(201)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('una página vacía corta el listado', async () => {
    const fetchMock = vi.fn().mockResolvedValue(pag([], { page: 1, page_size: 100, total_results: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await crearClientePrueba().listTransactions(D, H)
    expect(r).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tope de seguridad: si la API nunca termina, corta y registra un aviso', async () => {
    const llena = Array.from({ length: 100 }, (_, k) => `y${k}`)
    const fetchMock = vi.fn().mockResolvedValue(pag(llena, { page: 1, page_size: 100, total_results: 999999 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock)
    await crearClientePrueba().listTransactions(D, H)
    expect(fetchMock).toHaveBeenCalledTimes(20)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tope'))
    warn.mockRestore()
  })

  it('lanza si el API responde error (la conciliación lo registra)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(crearClientePrueba().listTransactions(new Date(), new Date())).rejects.toThrow('Wompi listado 503')
  })
})

describe('WompiClient.refundTransaction / getRefund (B-432)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hace POST /refunds con transaction_id y amount_in_cents', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: 1, status: 'PENDING' } }) })
    vi.stubGlobal('fetch', fetchMock)
    const c = new WompiClient({ publicKey: 'p', privateKey: 'prv_test_key', integrityKey: 'i', sandboxMode: true })
    await c.refundTransaction('tx-1', 300000)
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/refunds$/)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ transaction_id: 'tx-1', amount_in_cents: 300000 })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer prv_test_key')
  })

  it('getRefund hace GET /refunds/{id}', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: 1, status: 'APPROVED' } }) })
    vi.stubGlobal('fetch', fetchMock)
    const c = new WompiClient({ publicKey: 'p', privateKey: 'k', integrityKey: 'i', sandboxMode: true })
    expect((await c.getRefund(30954)).status).toBe('APPROVED')
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/refunds\/30954$/)
  })
})

describe('WompiClient — timeout por petición (B-996)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const respuestaOk = { ok: true, status: 200, json: () => Promise.resolve({ data: [], meta: {} }), text: () => Promise.resolve('') }

  const metodos: Array<[string, (c: WompiClient) => Promise<unknown>]> = [
    ['getAcceptanceToken', (c) => c.getAcceptanceToken()],
    ['createTransaction', (c) => c.createTransaction({ amountInCents: 1000, currency: 'COP', customerEmail: 'a@b.co', reference: 'r', redirectUrl: 'https://x.co', acceptanceToken: 't' })],
    ['getTransaction', (c) => c.getTransaction('tx-1')],
    ['listTransactions', (c) => c.listTransactions(new Date('2026-10-01'), new Date('2026-10-02'))],
    ['refundTransaction', (c) => c.refundTransaction('tx-1', 1000)],
    ['getRefund', (c) => c.getRefund(7)],
    ['voidTransaction', (c) => c.voidTransaction('tx-1')],
  ]

  it.each(metodos)('%s pasa un AbortSignal con el timeout de Wompi', async (_nombre, llamar) => {
    const fetchMock = vi.fn().mockResolvedValue(respuestaOk)
    vi.stubGlobal('fetch', fetchMock)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await llamar(crearClientePrueba()).catch(() => undefined)

    expect(fetchMock).toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(TIMEOUT_WOMPI_MS)
  })

  it.each(metodos)('%s rechaza cuando Wompi no responde y vence el timeout', async (_nombre, llamar) => {
    const controlador = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controlador.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })),
    )

    const pendiente = llamar(crearClientePrueba())
    controlador.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))

    await expect(pendiente).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('listTransactions aplica el timeout a cada página', async () => {
    const llena = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, created_at: '2026-10-01T12:00:00Z' }))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: llena, meta: { page_size: 100, total_results: 250 } }) })
    vi.stubGlobal('fetch', fetchMock)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await crearClientePrueba().listTransactions(new Date('2026-10-01'), new Date('2026-10-02'))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(timeoutSpy).toHaveBeenCalledTimes(3)
  })
})

describe('WompiClient — señal de plazo externa (B-1078)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** fetch que solo termina cuando la señal recibida se aborta, como uno colgado. */
  function fetchColgado() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))),
    )
  }

  it.each([
    ['refundTransaction', (c: WompiClient, s: AbortSignal) => c.refundTransaction('tx', 100, s)],
    ['getRefund', (c: WompiClient, s: AbortSignal) => c.getRefund(1, s)],
    ['getAcceptanceToken', (c: WompiClient, s: AbortSignal) => c.getAcceptanceToken(s)],
    ['createTransaction', (c: WompiClient, s: AbortSignal) => c.createTransaction(PARAMS_CREAR, s)],
    ['getTransaction', (c: WompiClient, s: AbortSignal) => c.getTransaction('tx', s)],
    ['voidTransaction', (c: WompiClient, s: AbortSignal) => c.voidTransaction('tx', s)],
  ])('%s: abortar el plazo externo aborta el fetch y rechaza con su reason', async (_n, llamar) => {
    const fetchMock = fetchColgado()
    vi.stubGlobal('fetch', fetchMock)
    const externo = new AbortController()
    const promesa = llamar(crearClientePrueba(), externo.signal)
    const razon = new Error('plazo agotado')
    externo.abort(razon)
    await expect(promesa).rejects.toBe(razon)
    expect(fetchMock.mock.calls[0][1].signal!.aborted).toBe(true)
  })

  it('createTransaction no-ok lanza WompiHttpError con el status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: () => Promise.resolve({ error: 'dup' }) }))
    const error = await crearClientePrueba().createTransaction(PARAMS_CREAR).catch((e) => e)
    expect(error).toBeInstanceOf(WompiHttpError)
    expect(error.status).toBe(422)
  })
})

describe('WompiClient.findTransactionsByReference — búsqueda por reference (B-1095)', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const resp = (data: unknown[]) => ({ ok: true, json: () => Promise.resolve({ data }) })

  it('envía reference codificada con la llave privada y devuelve la coincidencia exacta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp([{ id: 'a', reference: 'ref/1 &x' }]))
    vi.stubGlobal('fetch', fetchMock)
    const r = await crearClientePrueba().findTransactionsByReference('ref/1 &x')
    expect(r.map((t) => t.id)).toEqual(['a'])
    expect(fetchMock.mock.calls[0][0]).toContain('/transactions?reference=ref%2F1+%26x')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer prv_test_key')
  })

  it('descarta lo que no tenga la reference exacta aunque Wompi ignore el filtro', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp([
      { id: 'ajena', reference: 'otra' },
      { id: 'prefijo', reference: 'ref-1-extra' },
      { id: 'mia', reference: 'ref-1' },
      null,
    ])))
    const r = await crearClientePrueba().findTransactionsByReference('ref-1')
    expect(r.map((t) => t.id)).toEqual(['mia'])
  })

  it('sin coincidencias o sin data -> []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))
    expect(await crearClientePrueba().findTransactionsByReference('x')).toEqual([])
  })

  it('no-ok lanza', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(crearClientePrueba().findTransactionsByReference('x')).rejects.toThrow('503')
  })

  it('createTransaction 422 conserva el cuerpo en WompiHttpError.cuerpo', async () => {
    const cuerpo = { error: { type: 'INPUT_VALIDATION_ERROR', messages: { reference: ['ya usada'] } } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: () => Promise.resolve(cuerpo) }))
    const e = await crearClientePrueba().createTransaction(PARAMS_CREAR).catch((x) => x)
    expect(e.cuerpo).toEqual(cuerpo)
  })
})
