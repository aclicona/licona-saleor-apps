import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import type { CreateTransactionParams, WompiTransaction } from '../lib/wompi-client.js'
import { transactionInitializeHandler } from './transaction-initialize.js'

/**
 * B-707: CARD con token. Y, igual de importante, que PSE / NEQUI /
 * BANCOLOMBIA_TRANSFER / DAVIPLATA sigan mandando EXACTAMENTE lo de antes.
 */

const createTransaction = vi.fn<[CreateTransactionParams], Promise<WompiTransaction>>()
const getAcceptanceToken = vi.fn<[], Promise<string>>()
const TOKEN = 'tok_test_12345_SECRETOCOMPLETO'

function crearRequest(cuerpo: unknown) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() }
  log.child.mockImplementation(() => log)
  const req = { rawBody: JSON.stringify(cuerpo), body: cuerpo, headers: { 'saleor-signature': 'x' }, log }
  return { req: req as unknown as FastifyRequest, log }
}

function crearReply() {
  const captura: { payload: unknown } = { payload: undefined }
  const reply = { status: () => reply, send: (p: unknown) => ((captura.payload = p), reply) }
  return { reply: reply as unknown as FastifyReply, captura }
}

function payload(data?: Record<string, unknown>, currency = 'COP') {
  return {
    transaction: { id: 'VHJhbnNhY3Rpb25JdGVtOjE=', pspReference: '' },
    action: { amount: 120_000, currency },
    sourceObject: { email: 'c@example.com' },
    ...(data ? { data } : {}),
  }
}

async function ejecutar(data?: Record<string, unknown>, currency?: string) {
  const { req, log } = crearRequest(payload(data, currency))
  const { reply, captura } = crearReply()
  await transactionInitializeHandler(req, reply)
  return { log, respuesta: captura.payload as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  getAcceptanceToken.mockResolvedValue('acc-token')
  createTransaction.mockResolvedValue({
    id: 'wompi-1', status: 'PENDING', reference: 'r', amount_in_cents: 12_000_000, currency: 'COP',
    payment_method_type: 'CARD', redirect_url: 'https://x',
  })
  vi.mocked(wompiClient).mockReturnValue({ getAcceptanceToken, createTransaction } as unknown as ReturnType<typeof wompiClient>)
})

describe('transaction-initialize — CARD', () => {
  it('manda { type, token, installments } a Wompi', async () => {
    const { respuesta } = await ejecutar({ method: 'CARD', token: TOKEN, installments: 6 })
    expect(createTransaction.mock.calls[0][0].paymentMethod).toEqual({ type: 'CARD', token: TOKEN, installments: 6 })
    expect(respuesta.result).toBe('CHARGE_ACTION_REQUIRED')
  })

  it('usa 1 cuota si no vienen', async () => {
    await ejecutar({ method: 'CARD', token: TOKEN })
    expect(createTransaction.mock.calls[0][0].paymentMethod).toEqual({ type: 'CARD', token: TOKEN, installments: 1 })
  })

  it('ignora campos extra de data: no llegan a paymentMethod ni cambian monto/correo', async () => {
    await ejecutar({ method: 'CARD', token: TOKEN, installments: 2, amount: 1, customer_email: 'x@y.z', user_legal_id: '1' })
    const p = createTransaction.mock.calls[0][0]
    expect(p.paymentMethod).toEqual({ type: 'CARD', token: TOKEN, installments: 2 })
    expect(p.amountInCents).toBe(12_000_000)
    expect(p.customerEmail).toBe('c@example.com')
  })

  it.each([
    ['sin token', { method: 'CARD' }],
    ['token vacío', { method: 'CARD', token: '' }],
    ['token sin prefijo', { method: 'CARD', token: 'abc123' }],
    ['token no string', { method: 'CARD', token: 123 }],
    ['cuotas 0', { method: 'CARD', token: TOKEN, installments: 0 }],
    ['cuotas 37', { method: 'CARD', token: TOKEN, installments: 37 }],
    ['cuotas decimales', { method: 'CARD', token: TOKEN, installments: 2.5 }],
    ['cuotas string', { method: 'CARD', token: TOKEN, installments: '3' }],
  ])('%s → CHARGE_FAILURE sin llamar a Wompi', async (_t, data) => {
    const { respuesta } = await ejecutar(data)
    expect(respuesta).toMatchObject({ result: 'CHARGE_FAILURE', amount: 120_000 })
    expect(typeof respuesta.message).toBe('string')
    expect(getAcceptanceToken).not.toHaveBeenCalled()
    expect(createTransaction).not.toHaveBeenCalled()
  })

  it('no loguea el token completo (ni en éxito ni en rechazo)', async () => {
    const ok = await ejecutar({ method: 'CARD', token: TOKEN })
    const mal = await ejecutar({ method: 'CARD', token: TOKEN, installments: 99 })
    for (const { log } of [ok, mal]) {
      const todo = JSON.stringify(Object.values(log).flatMap((f) => (f as ReturnType<typeof vi.fn>).mock?.calls ?? []))
      expect(todo).not.toContain(TOKEN)
    }
  })

  it('la moneda no COP se rechaza igual que antes', async () => {
    const { respuesta } = await ejecutar({ method: 'CARD', token: TOKEN }, 'USD')
    expect(respuesta.result).toBe('CHARGE_FAILURE')
    expect(createTransaction).not.toHaveBeenCalled()
  })
})

describe('transaction-initialize — otros métodos sin cambios', () => {
  it('PSE', async () => {
    await ejecutar({ method: 'PSE', token: TOKEN, installments: 3, user_legal_id: '10', financial_institution_code: '1007' })
    expect(createTransaction.mock.calls[0][0].paymentMethod).toEqual({
      type: 'PSE', user_type: 'PERSON', user_legal_id_type: 'CC', user_legal_id: '10',
      financial_institution_code: '1007', payment_description: 'Pago en Licona',
    })
  })
  it('NEQUI con y sin teléfono', async () => {
    await ejecutar({ method: 'NEQUI', phone_number: '3001234567' })
    await ejecutar({ method: 'NEQUI' })
    expect(createTransaction.mock.calls[0][0].paymentMethod).toEqual({ type: 'NEQUI', phone_number: '3001234567' })
    expect(createTransaction.mock.calls[1][0].paymentMethod).toEqual({ type: 'NEQUI' })
  })
  it('BANCOLOMBIA_TRANSFER (también el método por defecto)', async () => {
    await ejecutar({ method: 'BANCOLOMBIA_TRANSFER', token: 'basura' })
    await ejecutar()
    const esperado = { type: 'BANCOLOMBIA_TRANSFER', user_type: 'PERSON', payment_description: 'Pago en Licona' }
    expect(createTransaction.mock.calls[0][0].paymentMethod).toEqual(esperado)
    expect(createTransaction.mock.calls[1][0].paymentMethod).toEqual(esperado)
  })
  it('DAVIPLATA sigue por default { type }', async () => {
    await ejecutar({ method: 'DAVIPLATA', token: TOKEN })
    expect(createTransaction.mock.calls[0][0].paymentMethod).toEqual({ type: 'DAVIPLATA' })
  })
})
