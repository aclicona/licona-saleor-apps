import { GraphQLClient, gql } from 'graphql-request'

const TRANSACTION_EVENT_REPORT = gql`
  mutation TransactionEventReport(
    $transactionId: ID!
    $type: TransactionEventTypeEnum!
    $amount: PositiveDecimal!
    $pspReference: String!
    $message: String
  ) {
    transactionEventReport(
      id: $transactionId
      type: $type
      amount: $amount
      pspReference: $pspReference
      message: $message
    ) {
      alreadyProcessed
      transaction { id }
      errors { field message code }
    }
  }
`

export type SaleorTransactionEventType =
  | 'CHARGE_SUCCESS'
  | 'CHARGE_FAILURE'
  | 'REFUND_SUCCESS'
  | 'REFUND_FAILURE'
  | 'CANCEL_SUCCESS'
  | 'CANCEL_FAILURE'

/** Error de negocio devuelto por la propia mutación (no por el transporte). */
export interface SaleorTransactionEventError {
  field: string | null
  message: string | null
  code: string
}

/**
 * Resultado de `transactionEventReport`.
 *
 * `alreadyProcessed` es la pieza clave de toda la semántica de entrega: Saleor
 * deduplica del lado servidor por `pspReference` + `type` + importe dentro de
 * un `traced_atomic_transaction()` con `select_for_update`. Como la App manda
 * `pspReference` = id de la transacción de Wompi (estable entre reintentos),
 * un reintento idéntico devuelve `alreadyProcessed: true` sin crear nada.
 * Descartar este dato — como hacía la versión anterior, que devolvía `void` —
 * era tirar la única evidencia observable de que la idempotencia funciona.
 */
export interface TransactionEventReportResult {
  alreadyProcessed: boolean
  transactionId: string | null
  errors: SaleorTransactionEventError[]
}

interface TransactionEventReportResponse {
  transactionEventReport: {
    alreadyProcessed: boolean | null
    transaction: { id: string } | null
    errors: SaleorTransactionEventError[] | null
  } | null
}

/**
 * Timeout de la llamada a Saleor.
 *
 * Acotarlo es parte de la semántica de entrega, no una micro-optimización: sin
 * timeout, una instancia de Saleor colgada deja el handler esperando hasta que
 * Wompi corte por su lado, y entonces Wompi decide el reintento sin que la App
 * haya podido clasificar nada. Con timeout, la App corta primero, clasifica el
 * fallo como transitorio y responde 500 — que es la señal explícita para que
 * Wompi reintente.
 */
const TIMEOUT_SALEOR_MS = 10_000

/**
 * Reporta un evento de transacción a Saleor.
 *
 * Lanza si el transporte falla (red, timeout, HTTP no-2xx, error GraphQL de
 * nivel superior). NO lanza por errores de negocio de la mutación: esos vienen
 * en `errors` y el llamador tiene que decidir qué hacer con ellos, porque la
 * diferencia entre "Saleor no me atendió" y "Saleor me dijo que no" es
 * justamente la diferencia entre responder 500 y responder 200.
 */
export async function reportTransactionEvent(params: {
  transactionId: string
  type: SaleorTransactionEventType
  amount: number
  pspReference: string
  message?: string
}): Promise<TransactionEventReportResult> {
  const apiUrl = process.env.SALEOR_API_URL
  const token = process.env.SALEOR_APP_TOKEN
  if (!apiUrl || !token) throw new Error('SALEOR_API_URL o SALEOR_APP_TOKEN no están configuradas')

  const client = new GraphQLClient(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })

  const data = await client.request<TransactionEventReportResponse>({
    document: TRANSACTION_EVENT_REPORT,
    variables: {
      transactionId: params.transactionId,
      type: params.type,
      amount: params.amount.toString(),
      pspReference: params.pspReference,
      message: params.message,
    },
    signal: AbortSignal.timeout(TIMEOUT_SALEOR_MS),
  })

  const payload = data?.transactionEventReport

  return {
    alreadyProcessed: payload?.alreadyProcessed === true,
    transactionId: payload?.transaction?.id ?? null,
    errors: payload?.errors ?? [],
  }
}
