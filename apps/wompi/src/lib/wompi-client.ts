import { createHash } from 'node:crypto'

const WOMPI_SANDBOX_URL = 'https://sandbox.wompi.co/v1'
const WOMPI_PROD_URL = 'https://production.wompi.co/v1'

export interface WompiConfig {
  publicKey: string
  privateKey: string
  integrityKey: string
  sandboxMode?: boolean
}

export interface CreateTransactionParams {
  amountInCents: number
  currency: 'COP'
  customerEmail: string
  reference: string
  redirectUrl: string
  acceptanceToken: string
  paymentMethod?: {
    type: string
    // NEQUI
    phone_number?: string
    // PSE + BANCOLOMBIA_TRANSFER
    user_type?: string
    payment_description?: string
    // PSE only
    user_legal_id_type?: string
    user_legal_id?: string
    financial_institution_code?: string
    // CARD
    installments?: number
    token?: string
  }
}

export interface WompiTransaction {
  id: string
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR'
  reference: string
  amount_in_cents: number
  currency: string
  payment_method_type: string
  redirect_url?: string
}

export class WompiClient {
  private baseUrl: string

  constructor(private config: WompiConfig) {
    this.baseUrl = config.sandboxMode === false ? WOMPI_PROD_URL : WOMPI_SANDBOX_URL
  }

  getPublicKey(): string {
    return this.config.publicKey
  }

  private integritySignature(reference: string, amountInCents: number, currency: string): string {
    const data = `${reference}${amountInCents}${currency}${this.config.integrityKey}`
    return createHash('sha256').update(data).digest('hex')
  }

  async getAcceptanceToken(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/merchants/${this.config.publicKey}`)
    if (!res.ok) throw new Error(`Wompi merchants ${res.status}`)
    const body = (await res.json()) as {
      data: { presigned_acceptance: { acceptance_token: string } }
    }
    return body.data.presigned_acceptance.acceptance_token
  }

  async createTransaction(params: CreateTransactionParams): Promise<WompiTransaction> {
    const res = await fetch(`${this.baseUrl}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.privateKey}`,
      },
      body: JSON.stringify({
        amount_in_cents: params.amountInCents,
        currency: params.currency,
        customer_email: params.customerEmail,
        reference: params.reference,
        redirect_url: params.redirectUrl,
        acceptance_token: params.acceptanceToken,
        signature: this.integritySignature(params.reference, params.amountInCents, params.currency),
        payment_method: params.paymentMethod ?? { type: 'CARD' },
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Wompi ${res.status}: ${JSON.stringify(err)}`)
    }
    return ((await res.json()) as { data: WompiTransaction }).data
  }

  async getTransaction(id: string): Promise<WompiTransaction> {
    const res = await fetch(`${this.baseUrl}/transactions/${id}`, {
      headers: { Authorization: `Bearer ${this.config.privateKey}` },
    })
    if (!res.ok) throw new Error(`Wompi ${res.status}`)
    return ((await res.json()) as { data: WompiTransaction }).data
  }

  async refundTransaction(id: string, amountInCents: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/transactions/${id}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.privateKey}`,
      },
      body: JSON.stringify({ amount_in_cents: amountInCents }),
    })
    if (!res.ok) throw new Error(`Wompi refund ${res.status}`)
  }

  async voidTransaction(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/transactions/${id}/void`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.privateKey}` },
    })
    if (!res.ok) throw new Error(`Wompi void ${res.status}`)
  }
}

export function wompiClient(): WompiClient {
  return new WompiClient({
    publicKey: process.env.WOMPI_PUBLIC_KEY ?? '',
    privateKey: process.env.WOMPI_PRIVATE_KEY ?? '',
    integrityKey: process.env.WOMPI_INTEGRITY_KEY ?? '',
    sandboxMode: process.env.WOMPI_SANDBOX !== 'false',
  })
}
