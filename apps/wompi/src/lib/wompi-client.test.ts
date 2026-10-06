import { createHash } from 'node:crypto'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WompiClient } from './wompi-client.js'

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
