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

  it('pagina, autentica con la llave privada y filtra por created_at', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(({ data: [{ id: 'a', created_at: '2026-10-02T10:00:00Z' }], meta: { total_pages: 2 } })) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(({ data: [{ id: 'b', created_at: '2026-09-01T10:00:00Z' }], meta: { total_pages: 2 } })) })
    vi.stubGlobal('fetch', fetchMock)
    const r = await crearClientePrueba().listTransactions(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T12:00:00Z'))
    expect(r.map((t) => t.id)).toEqual(['a'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/transactions?from_date=2026-10-01&until_date=2026-10-02&page=1')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer prv_test_key')
  })

  it('lanza si el API responde error (la conciliación lo registra)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(crearClientePrueba().listTransactions(new Date(), new Date())).rejects.toThrow('Wompi listado 503')
  })
})
