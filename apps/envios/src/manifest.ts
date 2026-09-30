/**
 * Manifiesto de la App. Vive aparte de `index.ts` para poder importarlo sin
 * arrancar el servidor (p. ej. `scripts/validar-subscriptions.mjs`, que valida
 * las `query` de suscripción contra el esquema de Saleor).
 */
export function construirManifiesto(APP_URL: string) {
  return {
    id: 'app.licona.envios',
    version: '1.0.0',
    name: 'Licona Envíos CO',
    about: 'Integración con Servientrega, Coordinadora y TCC',
    permissions: ['MANAGE_SHIPPING'],
    appUrl: APP_URL,
    tokenTargetUrl: `${APP_URL}/api/register`,
    webhooks: [
      {
        name: 'Shipping methods for checkout',
        syncEvents: ['SHIPPING_LIST_METHODS_FOR_CHECKOUT'],
        isActive: true,
        targetUrl: `${APP_URL}/api/webhooks/shipping-list-methods`,
        query: `subscription {
  event {
    ... on ShippingListMethodsForCheckout {
      checkout {
        id
        shippingAddress {
          city
          postalCode
          countryArea
        }
        lines {
          quantity
          variant {
            weight { value unit }
            product { weight { value unit } }
          }
        }
      }
    }
  }
}`,
      },
    ],
    extensions: [],
    requiredSaleorVersion: '>=3.22.0',
  }
}
