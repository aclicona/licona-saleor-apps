import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))
vi.mock('../lib/saleor-client.js', () => ({ obtenerTransaccionesDelCheckout: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import { obtenerTransaccionesDelCheckout } from '../lib/saleor-client.js'
import { transactionInitializeHandler } from './transaction-initialize.js'

/** B-2616: el handler no crea un segundo cobro sobre un checkout con un pago vivo. */

const CHECKOUT = Buffer.from('Checkout:1').toString('base64')
const getAcceptanceToken = vi.fn()
const createTransaction = vi.fn()
const getTransaction = vi.fn()
const findTransactionsByReference = vi.fn()

async function ejecutar(cambios: Record<string, unknown> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const body = {
    transaction: { id: 'mia', pspReference: '' },
    action: { amount: 120_000, currency: 'COP' },
    sourceObject: { id: CHECKOUT, email: 'cliente@example.com' },
    data: { method: 'NEQUI' },
    ...cambios,
  }
  const req = { rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest
  let respuesta: unknown
  const reply = { status: () => reply, send: (p: unknown) => ((respuesta = p), reply) }
  await transactionInitializeHandler(req, reply as unknown as FastifyReply)
  return respuesta as Record<string, unknown>
}

const otra = () => ({
  transacciones: [{ id: 'otra', pspReference: 'psp-otra', createdAt: new Date(Date.now() - 60_000).toISOString(), createdBy: null, events: [] }],
  erroresParciales: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  getAcceptanceToken.mockResolvedValue('acc')
  createTransaction.mockResolvedValue({ id: 'w1', redirect_url: 'https://x' })
  vi.mocked(wompiClient).mockReturnValue({
    getAcceptanceToken,
    createTransaction,
    getTransaction,
    findTransactionsByReference,
  } as unknown as ReturnType<typeof wompiClient>)
  vi.mocked(obtenerTransaccionesDelCheckout).mockResolvedValue(otra())
})

describe('guardia de segundo cobro en transaction-initialize (B-2616)', () => {
  it('con un pago PENDING rechaza sin token ni creación, sin pspReference, data ni actions', async () => {
    getTransaction.mockResolvedValue({ id: 'psp-otra', status: 'PENDING' })

    expect(await ejecutar()).toEqual({ result: 'CHARGE_FAILURE', amount: 120_000, message: 'Ya hay un pago en curso para este carrito' })
    expect(getAcceptanceToken).not.toHaveBeenCalled()
    expect(createTransaction).not.toHaveBeenCalled()
  })

  it('si Wompi falla al comprobar rechaza con mensaje fijo', async () => {
    getTransaction.mockRejectedValue(new Error('secreto-interno'))

    expect(await ejecutar()).toEqual({ result: 'CHARGE_FAILURE', amount: 120_000, message: 'No se pudo comprobar un pago anterior; reintente' })
    expect(createTransaction).not.toHaveBeenCalled()
  })

  it('con el pago anterior DECLINED crea el cobro', async () => {
    getTransaction.mockResolvedValue({ id: 'psp-otra', status: 'DECLINED' })

    expect(await ejecutar()).toMatchObject({ result: 'CHARGE_ACTION_REQUIRED', pspReference: 'w1' })
    expect(createTransaction).toHaveBeenCalledTimes(1)
  })

  it('si Saleor falla al consultar, crea el cobro', async () => {
    vi.mocked(obtenerTransaccionesDelCheckout).mockRejectedValue(new Error('saleor'))

    expect(await ejecutar()).toMatchObject({ pspReference: 'w1' })
  })

  it('sin id de checkout la guardia no corre', async () => {
    await ejecutar({ sourceObject: { email: 'cliente@example.com' } })

    expect(obtenerTransaccionesDelCheckout).not.toHaveBeenCalled()
    expect(createTransaction).toHaveBeenCalledTimes(1)
  })

  it.each([0, -1])('importe %d: rechaza sin hablar con Wompi', async (amount) => {
    expect(await ejecutar({ action: { amount, currency: 'COP' } })).toEqual({
      result: 'CHARGE_FAILURE',
      amount,
      message: 'El carrito no tiene saldo por cobrar',
    })
    expect(wompiClient).not.toHaveBeenCalled()
    expect(obtenerTransaccionesDelCheckout).not.toHaveBeenCalled()
  })

  it('una validación de CARD fallida no llega a la guardia', async () => {
    await ejecutar({ data: { method: 'CARD' } })

    expect(obtenerTransaccionesDelCheckout).not.toHaveBeenCalled()
  })
})
