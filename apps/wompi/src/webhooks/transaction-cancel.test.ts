import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
import { transactionCancelHandler } from './transaction-cancel.js'
import { WompiHttpError } from '../lib/wompi-error.js'

const voidTransaction = vi.fn()
const PSP = '12084641-1791286722-99200'
const TEXTO_INTERNO = 'detalle-interno-secreto'

async function correr(pspReference: string = PSP) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const req = {
    rawBody: '{}',
    body: { transaction: { id: 'T', pspReference }, action: { amount: 3000 } },
    headers: {},
    log,
  } as unknown as FastifyRequest
  let payload: any
  let status: number | undefined
  const reply = {
    status: (s: number) => ((status = s), reply),
    send: (p: unknown) => ((payload = p), reply),
  }
  await transactionCancelHandler(req, reply as unknown as FastifyReply)
  return { payload, status, log }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(wompiClient).mockReturnValue({ voidTransaction } as unknown as ReturnType<typeof wompiClient>)
})

describe('transactionCancelHandler (B-1072)', () => {
  it('anulación aceptada -> CANCEL_SUCCESS con el pspReference de la transacción', async () => {
    voidTransaction.mockResolvedValue({})
    const { payload } = await correr()
    // B-1080: la anulación recibe la señal del plazo global.
    expect(voidTransaction).toHaveBeenCalledWith(PSP, expect.any(AbortSignal))
    expect(payload).toEqual({ result: 'CANCEL_SUCCESS', amount: 3000, pspReference: PSP })
  })

  it('firma inválida -> 401 y no llama a Wompi', async () => {
    vi.mocked(verifySaleorWebhook).mockRejectedValueOnce(new Error('firma'))
    const { payload, status } = await correr()
    expect(status).toBe(401)
    expect(payload).toEqual({ error: 'Invalid signature' })
    expect(voidTransaction).not.toHaveBeenCalled()
  })

  it('firma inválida (SaleorWebhookError) también -> 401', async () => {
    vi.mocked(verifySaleorWebhook).mockRejectedValueOnce(new SaleorWebhookError('x', 'bad_signature' as never))
    const { status } = await correr()
    expect(status).toBe(401)
  })

  it('sin pspReference -> CANCEL_FAILURE con mensaje fijo', async () => {
    const { payload } = await correr('')
    expect(payload).toEqual({ result: 'CANCEL_FAILURE', amount: 3000, message: 'Sin pspReference' })
    expect(voidTransaction).not.toHaveBeenCalled()
  })

  it('rechazo 4xx de Wompi -> CANCEL_FAILURE con mensaje fijo, sin texto interno', async () => {
    voidTransaction.mockRejectedValue(new WompiHttpError(TEXTO_INTERNO, 422))
    const { payload, log } = await correr()
    expect(payload.result).toBe('CANCEL_FAILURE')
    expect(payload.amount).toBe(3000)
    expect(JSON.stringify(payload)).not.toContain(TEXTO_INTERNO)
    expect(log.error).toHaveBeenCalled()
  })

  it.each([
    ['timeout', Object.assign(new Error(TEXTO_INTERNO), { name: 'TimeoutError' })],
    ['abort', Object.assign(new Error(TEXTO_INTERNO), { name: 'AbortError' })],
    ['red', new TypeError(`fetch failed ${TEXTO_INTERNO}`)],
    ['5xx', new WompiHttpError(TEXTO_INTERNO, 503)],
    ['429', new WompiHttpError(TEXTO_INTERNO, 429)],
    ['408', new WompiHttpError(TEXTO_INTERNO, 408)],
  ])('%s -> respuesta no final (sin result) con pspReference, sin texto interno', async (_n, error) => {
    voidTransaction.mockRejectedValue(error)
    const { payload, log } = await correr()
    expect(payload).toEqual({ pspReference: PSP })
    expect(JSON.stringify(payload)).not.toContain(TEXTO_INTERNO)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: error }), expect.any(String))
  })
})
