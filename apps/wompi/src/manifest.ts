/**
 * Manifiesto de la App. Vive aparte de `index.ts` para poder importarlo sin
 * arrancar el servidor (p. ej. `scripts/validar-subscriptions.mjs`, que valida
 * las `query` de suscripción contra el esquema de Saleor).
 */
export function construirManifiesto(APP_URL: string) {
  return {
    id: 'app.licona.wompi',
    version: '1.0.0',
    name: 'Wompi (Bancolombia)',
    about: 'Pasarela de pagos Wompi: tarjetas, PSE, Nequi, Daviplata, Bancolombia Transfer.',
    permissions: ['HANDLE_PAYMENTS', 'HANDLE_CHECKOUTS'],
    appUrl: APP_URL,
    tokenTargetUrl: `${APP_URL}/api/register`,
    webhooks: [
      {
        name: 'Payment Gateway Initialize Session',
        syncEvents: ['PAYMENT_GATEWAY_INITIALIZE_SESSION'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/payment-gateway-initialize-session`,
        query: `subscription {
  event {
    ... on PaymentGatewayInitializeSession {
      sourceObject {
        ... on Checkout { id totalPrice { gross { amount currency } } }
      }
      data
      amount
    }
  }
}`,
      },
      {
        name: 'Transaction Initialize Session',
        syncEvents: ['TRANSACTION_INITIALIZE_SESSION'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/transaction-initialize-session`,
        query: `subscription {
  event {
    ... on TransactionInitializeSession {
      transaction { id pspReference }
      sourceObject {
        ... on Checkout {
          id
          email
          billingAddress { firstName lastName streetAddress1 city country { code } postalCode }
          totalPrice { gross { amount currency } }
        }
      }
      data
      action { amount currency }
    }
  }
}`,
      },
      {
        name: 'Transaction Process Session',
        syncEvents: ['TRANSACTION_PROCESS_SESSION'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/transaction-process-session`,
        query: `subscription {
  event {
    ... on TransactionProcessSession {
      transaction { id pspReference }
      action { amount }
      data
    }
  }
}`,
      },
      {
        name: 'Transaction Charge Requested',
        syncEvents: ['TRANSACTION_CHARGE_REQUESTED'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/transaction-charge-requested`,
        query: `subscription {
  event {
    ... on TransactionChargeRequested {
      transaction { id pspReference }
      action { amount }
    }
  }
}`,
      },
      {
        name: 'Transaction Refund Requested',
        syncEvents: ['TRANSACTION_REFUND_REQUESTED'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/transaction-refund-requested`,
        query: `subscription {
  event {
    ... on TransactionRefundRequested {
      transaction { id pspReference }
      action { amount }
    }
  }
}`,
      },
      {
        name: 'Transaction Cancelation Requested',
        syncEvents: ['TRANSACTION_CANCELATION_REQUESTED'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/transaction-cancelation-requested`,
        query: `subscription {
  event {
    ... on TransactionCancelationRequested {
      transaction { id pspReference }
      action { amount }
    }
  }
}`,
      },
    ],
    extensions: [],
    requiredSaleorVersion: '>=3.22.0',
  }
}
