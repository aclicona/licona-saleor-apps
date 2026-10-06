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
  created_at?: string
}

/** Tope de páginas por consulta de conciliación: acota la corrida si el API pagina sin fin. */
const MAX_PAGINAS_LISTADO = 20
const TAM_PAGINA_LISTADO = 100

export class WompiClient {
  private baseUrl: string

  constructor(private config: WompiConfig) {
    this.baseUrl = config.sandboxMode === false ? WOMPI_PROD_URL : WOMPI_SANDBOX_URL
  }

  getPublicKey(): string {
    return this.config.publicKey
  }

  // Pública (no `private`) para poder testearla directamente: es una función
  // pura que verifica la integridad del cobro (Wompi la recalcula del lado
  // del servidor y rechaza la transacción si no coincide), así que merece
  // cobertura propia sin depender de mockear `fetch` en `createTransaction`.
  integritySignature(reference: string, amountInCents: number, currency: string): string {
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

  /**
   * Lista transacciones creadas en `[desde, hasta]` para la conciliación (B-412).
   *
   * `GET /transactions?from_date&until_date&page&page_size` con la llave privada, fechas `YYYY-MM-DD`
   * (granularidad de día, por eso se filtra después por `created_at` si viene). Verificado contra el sandbox:
   * la respuesta es `{ data: [...], meta: { page, page_size, total_results } }`; Wompi NO envía `total_pages`.
   * Se pagina con `ceil(total_results / page_size)` y, por defensa ante un `meta` ausente, también se corta
   * al recibir una página vacía o con menos filas que `page_size`. `MAX_PAGINAS_LISTADO` evita un bucle infinito.
   */
  async listTransactions(desde: Date, hasta: Date): Promise<WompiTransaction[]> {
    const dia = (d: Date) => d.toISOString().slice(0, 10)
    const todas: WompiTransaction[] = []
    for (let pagina = 1; pagina <= MAX_PAGINAS_LISTADO; pagina++) {
      const qs = new URLSearchParams({
        from_date: dia(desde),
        until_date: dia(hasta),
        page: String(pagina),
        page_size: String(TAM_PAGINA_LISTADO),
      })
      const res = await fetch(`${this.baseUrl}/transactions?${qs}`, {
        headers: { Authorization: `Bearer ${this.config.privateKey}` },
      })
      if (!res.ok) throw new Error(`Wompi listado ${res.status}`)
      const body = (await res.json()) as {
        data?: WompiTransaction[]
        meta?: { page?: number; page_size?: number; total_results?: number }
      }
      const filas = body.data ?? []
      todas.push(...filas)
      const { total_results: total, page_size: tamMeta } = body.meta ?? {}
      const tam = tamMeta || TAM_PAGINA_LISTADO
      if (filas.length === 0 || filas.length < tam) break
      if (total != null && pagina >= Math.ceil(total / tam)) break
      if (pagina === MAX_PAGINAS_LISTADO) {
        console.warn(
          `Wompi listado: se alcanzó el tope de ${MAX_PAGINAS_LISTADO} páginas (${todas.length} transacciones); puede haber más sin conciliar`,
        )
      }
    }
    return todas.filter((t) => {
      if (!t.created_at) return true
      const creada = new Date(t.created_at).getTime()
      return creada >= desde.getTime() && creada <= hasta.getTime()
    })
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
