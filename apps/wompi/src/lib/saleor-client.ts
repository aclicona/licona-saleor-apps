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

export async function reportTransactionEvent(params: {
  transactionId: string
  type: SaleorTransactionEventType
  amount: number
  pspReference: string
  message?: string
}): Promise<void> {
  const apiUrl = process.env.SALEOR_API_URL
  const token = process.env.SALEOR_APP_TOKEN
  if (!apiUrl || !token) throw new Error('SALEOR_API_URL or SALEOR_APP_TOKEN not set')

  const client = new GraphQLClient(apiUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })

  await client.request(TRANSACTION_EVENT_REPORT, {
    transactionId: params.transactionId,
    type: params.type,
    amount: params.amount.toString(),
    pspReference: params.pspReference,
    message: params.message,
  })
}
