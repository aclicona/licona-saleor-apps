import { createHash } from 'node:crypto'
import { WompiHttpError } from './wompi-error.js'

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

export interface WompiRefund {
  id: number | string
  transaction_id: string
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'ERROR' | string
  amount_in_cents: number
  status_message?: string | null
  created_at?: string
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
  /**
   * Solo en `GET /transactions/{id}` (B-1097). Dato externo sin validar: leer SIEMPRE con `refundsEmbebidos`
   * (`refunds-embebidos.ts`), que descarta los items mal formados.
   */
  refunds?: unknown
}

/** Tope de páginas por consulta de conciliación: acota la corrida si el API pagina sin fin. */
const MAX_PAGINAS_LISTADO = 20
const TAM_PAGINA_LISTADO = 100

/**
 * Timeout por petición a Wompi (B-996). Sin él, un GET colgado deja el candado de la conciliación
 * (B-412, compartido con el endpoint HTTP) tomado ~300 s (default de undici) y los handlers síncronos
 * ante Saleor sin responder a tiempo. En `listTransactions` aplica a cada página.
 */
export const TIMEOUT_WOMPI_MS = 15_000

export class WompiClient {
  private baseUrl: string

  constructor(private config: WompiConfig) {
    this.baseUrl = config.sandboxMode === false ? WOMPI_PROD_URL : WOMPI_SANDBOX_URL
  }

  /**
   * `plazo` (opcional) es una señal externa, p. ej. el plazo global de un webhook síncrono (B-1078):
   * la petición se corta con lo que ocurra primero, el timeout propio o esa señal.
   */
  private fetchWompi(url: string, init: RequestInit = {}, plazo?: AbortSignal): Promise<Response> {
    const propio = AbortSignal.timeout(TIMEOUT_WOMPI_MS)
    return fetch(url, { ...init, signal: plazo ? AbortSignal.any([propio, plazo]) : propio })
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

  async getAcceptanceToken(plazo?: AbortSignal): Promise<string> {
    const res = await this.fetchWompi(`${this.baseUrl}/merchants/${this.config.publicKey}`, {}, plazo)
    if (!res.ok) throw new WompiHttpError(`Wompi merchants ${res.status}`, res.status)
    const body = (await res.json()) as {
      data: { presigned_acceptance: { acceptance_token: string } }
    }
    return body.data.presigned_acceptance.acceptance_token
  }

  async createTransaction(params: CreateTransactionParams, plazo?: AbortSignal): Promise<WompiTransaction> {
    const res = await this.fetchWompi(
      `${this.baseUrl}/transactions`,
      {
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
      },
      plazo,
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new WompiHttpError(`Wompi ${res.status}: ${JSON.stringify(err)}`, res.status)
    }
    return ((await res.json()) as { data: WompiTransaction }).data
  }

  async getTransaction(id: string, plazo?: AbortSignal): Promise<WompiTransaction> {
    const res = await this.fetchWompi(
      `${this.baseUrl}/transactions/${id}`,
      { headers: { Authorization: `Bearer ${this.config.privateKey}` } },
      plazo,
    )
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
      const res = await this.fetchWompi(`${this.baseUrl}/transactions?${qs}`, {
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

  /**
   * Crea un reembolso (parcial o total) con `POST /refunds` (B-432).
   *
   * El endpoint `POST /transactions/{id}/refund` que se usaba antes NO existe
   * (404 con cuerpo vacío, verificado contra el sandbox el 2026-10-06). El real
   * recibe `{transaction_id, amount_in_cents}` y responde 201 con el reembolso
   * en `PENDING`; pasa a `APPROVED` unos segundos después (`getRefund`).
   * `/transactions/{id}/void` solo anula por el monto completo.
   */
  async refundTransaction(transactionId: string, amountInCents: number, plazo?: AbortSignal): Promise<WompiRefund> {
    const res = await this.fetchWompi(
      `${this.baseUrl}/refunds`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.privateKey}`,
        },
        body: JSON.stringify({ transaction_id: transactionId, amount_in_cents: amountInCents }),
      },
      plazo,
    )
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      throw new WompiHttpError(`Wompi refund ${res.status}: ${err}`, res.status)
    }
    return ((await res.json()) as { data: WompiRefund }).data
  }

  async getRefund(id: string | number, plazo?: AbortSignal): Promise<WompiRefund> {
    const res = await this.fetchWompi(
      `${this.baseUrl}/refunds/${id}`,
      { headers: { Authorization: `Bearer ${this.config.privateKey}` } },
      plazo,
    )
    if (!res.ok) throw new WompiHttpError(`Wompi getRefund ${res.status}`, res.status)
    return ((await res.json()) as { data: WompiRefund }).data
  }

  async voidTransaction(id: string, plazo?: AbortSignal): Promise<void> {
    const res = await this.fetchWompi(
      `${this.baseUrl}/transactions/${id}/void`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.config.privateKey}` } },
      plazo,
    )
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
