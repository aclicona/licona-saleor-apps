import { describe, it, expect, vi } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'

vi.mock('@licona/webhook-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@licona/webhook-utils')>()),
  verifySaleorWebhook: vi.fn(),
}))
vi.mock('../lib/wompi-client.js', () => ({ wompiClient: vi.fn() }))

import { wompiClient } from '../lib/wompi-client.js'
import { transactionProcessHandler } from './transaction-process.js'

async function correr(estadoWompi: string) {
  vi.mocked(wompiClient).mockReturnValue({
    getTransaction: vi.fn().mockResolvedValue({ status: estadoWompi }),
  } as unknown as ReturnType<typeof wompiClient>)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  const body = { transaction: { id: 'T', pspReference: 'wompi-1' }, action: { amount: 100 } }
  const req = { rawBody: '{}', body, headers: {}, log } as unknown as FastifyRequest
  let payload: any
  const reply = { status: () => reply, send: (p: unknown) => ((payload = p), reply) }
  await transactionProcessHandler(req, reply as unknown as FastifyReply)
  return payload
}

describe('transactionProcessHandler — actions (B-432)', () => {
  it('APPROVED responde CHARGE_SUCCESS con actions [REFUND]', async () => {
    expect(await correr('APPROVED')).toMatchObject({ result: 'CHARGE_SUCCESS', actions: ['REFUND'] })
  })
  it('PENDING responde CHARGE_ACTION_REQUIRED con actions []', async () => {
    expect(await correr('PENDING')).toMatchObject({ result: 'CHARGE_ACTION_REQUIRED', actions: [] })
  })
  it('DECLINED responde CHARGE_FAILURE con actions []', async () => {
    expect(await correr('DECLINED')).toMatchObject({ result: 'CHARGE_FAILURE', actions: [] })
  })
})
