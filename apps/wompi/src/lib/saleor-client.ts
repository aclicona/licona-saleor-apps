import { GraphQLClient, gql } from 'graphql-request'
import { accionesParaEvento, type AccionTransaccion } from './acciones.js'

const TRANSACTION_EVENT_REPORT = gql`
  mutation TransactionEventReport(
    $transactionId: ID!
    $type: TransactionEventTypeEnum!
    $amount: PositiveDecimal!
    $pspReference: String!
    $message: String
    $availableActions: [TransactionActionEnum!]
  ) {
    transactionEventReport(
      id: $transactionId
      type: $type
      amount: $amount
      pspReference: $pspReference
      message: $message
      availableActions: $availableActions
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
  | 'INFO'

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

/** Cliente GraphQL de Saleor con el token de la App. Lanza si falta la configuración. */
function crearClienteSaleor(): GraphQLClient {
  const apiUrl = process.env.SALEOR_API_URL
  const token = process.env.SALEOR_APP_TOKEN
  if (!apiUrl || !token) throw new Error('SALEOR_API_URL o SALEOR_APP_TOKEN no están configuradas')

  return new GraphQLClient(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

/** `undefined` hace que la variable no viaje (JSON la omite) y Saleor conserve las acciones actuales. */
function accionesDeclaradas(params: {
  type: SaleorTransactionEventType
  availableActions?: AccionTransaccion[] | null
}): AccionTransaccion[] | undefined {
  if (params.type === 'INFO') return undefined
  if (params.availableActions === undefined) return accionesParaEvento(params.type)
  return params.availableActions ?? undefined
}

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
  /** Omitido → `accionesParaEvento(type)`. Para `INFO` se ignora: la variable no viaja (Saleor sobrescribe las acciones si no es null). */
  availableActions?: AccionTransaccion[] | null
}): Promise<TransactionEventReportResult> {
  const client = crearClienteSaleor()

  const data = await client.request<TransactionEventReportResponse>({
    document: TRANSACTION_EVENT_REPORT,
    variables: {
      transactionId: params.transactionId,
      type: params.type,
      amount: params.amount.toString(),
      pspReference: params.pspReference,
      message: params.message,
      availableActions: accionesDeclaradas(params),
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

// ─── Solicitudes pendientes (B-1083) ─────────────────────────────────────────

export type TipoSolicitud = 'CANCEL_REQUEST' | 'REFUND_REQUEST'

export interface EventoTransaccionSaleor {
  type: string
  pspReference: string | null
  createdAt: string
  amount: number
}

export interface TransaccionConSolicitudes {
  id: string
  cancelPendingAmount: number
  refundPendingAmount: number
  events: EventoTransaccionSaleor[]
}

/** Tamaño de página y tope de páginas: acotan el trabajo de una corrida de conciliación. */
const TAM_PAGINA_SOLICITUDES = 50
export const MAX_PAGINAS_SOLICITUDES = 5

const TRANSACCIONES_CON_SOLICITUD = gql`
  query TransaccionesConSolicitud($tipo: TransactionEventTypeEnum!, $desde: DateTime!, $after: String) {
    transactions(
      first: ${TAM_PAGINA_SOLICITUDES}
      after: $after
      where: { events: [{ type: { eq: $tipo }, createdAt: { gte: $desde } }] }
      sortBy: { field: CREATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          cancelPendingAmount { amount }
          refundPendingAmount { amount }
          events { type pspReference createdAt amount { amount } }
        }
      }
    }
  }
`

interface TransaccionesConSolicitudResponse {
  transactions: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    edges: Array<{
      node: {
        id: string
        cancelPendingAmount: { amount: number }
        refundPendingAmount: { amount: number }
        events: Array<{ type: string; pspReference: string | null; createdAt: string; amount: { amount: number } }>
      }
    }>
  } | null
}

/**
 * Transacciones de esta App que tienen un evento `tipo` (CANCEL_REQUEST / REFUND_REQUEST) creado desde
 * `desde`. El filtro `events` exige Saleor ≥ 3.23. NO filtra por pendiente > 0: eso lo hace el llamador.
 * Pagina hasta `MAX_PAGINAS_SOLICITUDES`; lanza si falla el transporte.
 */
export async function listarTransaccionesConSolicitud(params: {
  tipo: TipoSolicitud
  desde: Date
  /** Se invoca si quedaban más páginas al llegar al tope (hay solicitudes sin revisar). */
  alLlegarAlTope?: () => void
}): Promise<TransaccionConSolicitudes[]> {
  const client = crearClienteSaleor()
  const resultado: TransaccionConSolicitudes[] = []
  let after: string | null = null

  for (let pagina = 1; pagina <= MAX_PAGINAS_SOLICITUDES; pagina++) {
    const data: TransaccionesConSolicitudResponse = await client.request<TransaccionesConSolicitudResponse>({
      document: TRANSACCIONES_CON_SOLICITUD,
      variables: { tipo: params.tipo, desde: params.desde.toISOString(), after },
      signal: AbortSignal.timeout(TIMEOUT_SALEOR_MS),
    })
    const conexion = data?.transactions
    for (const { node } of conexion?.edges ?? []) {
      resultado.push({
        id: node.id,
        cancelPendingAmount: Number(node.cancelPendingAmount.amount),
        refundPendingAmount: Number(node.refundPendingAmount.amount),
        events: node.events.map((e) => ({
          type: e.type,
          pspReference: e.pspReference,
          createdAt: e.createdAt,
          amount: Number(e.amount.amount),
        })),
      })
    }
    if (!conexion?.pageInfo.hasNextPage) break
    if (pagina === MAX_PAGINAS_SOLICITUDES) params.alLlegarAlTope?.()
    after = conexion.pageInfo.endCursor
  }
  return resultado
}
