# Pago con tarjeta (CARD) — contrato backend ↔ storefront (B-707, parte 1 de B-423)

## Flujo

1. **Llave pública.** `PAYMENT_GATEWAY_INITIALIZE_SESSION` (`payment-gateway-initialize.ts`) ya responde
   `data = { publicKey, methods, currency }`. `publicKey` sale de `WOMPI_PUBLIC_KEY` (`client.getPublicKey()`);
   es la única llave que se expone (nunca la privada ni la de integridad). El storefront la lee de la respuesta
   de `paymentGatewayInitialize` (`data.publicKey`).
2. **Tokenización en el navegador.** El storefront manda los datos de la tarjeta **directo a Wompi**
   (`POST {base}/tokens/cards` con `Authorization: Bearer <publicKey>`) y recibe `tok_…`.
   El PAN/CVC **nunca** pasan por Saleor ni por esta App.
3. **`transactionInitialize`** con
   `paymentData = { method: 'CARD', token: 'tok_…', installments: N }`.
4. La App valida (`src/lib/tarjeta.ts`) y manda a Wompi `payment_method: { type: 'CARD', token, installments }`.

## Validación (entrada NO confiable: `data` viaja por el navegador)

| Campo | Regla |
|---|---|
| `token` | string, `^tok_[A-Za-z0-9_-]{1,120}$` |
| `installments` | entero 1–36; ausente/`null` ⇒ 1. Un string (`"3"`), decimal o fuera de rango se rechaza |

Si algo falla: `{ result: 'CHARGE_FAILURE', amount, message }` **sin llamar a Wompi** (ni al acceptance token).
`token` e `installments` no se usan para nada más (ni referencia, ni monto, ni correo). El token no se loguea
(el rechazo solo registra `metodo: 'CARD'`). Los demás métodos (PSE, NEQUI, BANCOLOMBIA_TRANSFER, DAVIPLATA)
se comportan exactamente igual que antes (tests en `transaction-initialize-card.test.ts`).

## Respuesta

Éxito: `CHARGE_ACTION_REQUIRED` con `pspReference` = id de Wompi y `data: { redirectUrl, wompiTransactionId }`.
Con tarjeta Wompi suele devolver la transacción `PENDING` y **sin** `redirect_url` (el resultado llega por el
evento entrante / `redirectUrl` de la App). **Supuesto sin verificar**: 3DS. El storefront debe tolerar
`redirectUrl` ausente o `undefined` y esperar el estado final (polling de la orden / página `/checkout/orden/<id>`).

## Qué se supone que hará el storefront (parte 2)

- Obtener `publicKey` de `paymentGatewayInitialize`, tokenizar con Wompi y enviar `paymentData` como arriba.
- Mostrar el selector de cuotas (1–36) y los términos de Wompi (ver abajo).
- No enviar nunca datos de tarjeta a Saleor; solo el token.

## `acceptance_token` / `accept_personal_auth`

- Hoy la App ya manda `acceptance_token` (el `presigned_acceptance` del comercio, vía `GET /merchants/<pub>`) para
  **todos** los métodos; con CARD sigue igual. No cambió.
- Wompi también publica `presigned_personal_data_auth` (`accept_personal_auth`) en esa misma respuesta. **No se
  envía** y no se pudo verificar si es obligatorio para tarjeta (prohibido llamar a Wompi desde esta tarea).
  Decisión mínima segura: no añadirlo ni aceptar nada del comprador por él; ambos tokens son del comercio, no
  valores que el navegador deba aportar, y aceptar los términos en nombre del comprador sin mostrárselos tiene
  implicación legal. **Verificar en la parte 3 (sandbox):** si Wompi responde 422 pidiéndolo, añadirlo en
  `getAcceptanceToken`/`createTransaction` y exigir un check explícito de aceptación en el storefront.
