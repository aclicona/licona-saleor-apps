# saleor-apps

Monorepo pnpm de Saleor Apps para el e-commerce colombiano. Cada app es un microservicio independiente que se comunica con Saleor via webhooks síncronos (JWS/RS256).

**Contexto de proyecto completo:** `../CLAUDE.md` (o abre `ecommerce/` en Claude Code).

---

## Apps disponibles

| App | Puerto local | Propósito |
|---|---|---|
| `apps/wompi` | 3001 | Pasarela de pago Wompi (PSE, Nequi, tarjeta, efectivo) |
| `apps/envios` | 3002 | Métodos de envío (Servientrega, Coordinadora, TCC) |

---

## Local Dev

**Prereqs:** Node 22, pnpm. Requiere `saleor-api` corriendo en `localhost:8000`.

```bash
# Primera vez — instalar todas las deps del monorepo
cd ecommerce/saleor-apps
pnpm install

# Arrancar una app específica
pnpm --filter @licona/app-wompi dev    # → http://localhost:3001
pnpm --filter @licona/app-envios dev   # → http://localhost:3002
```

Después de arrancar una app, registrarla en el Dashboard local:
1. Ir a `http://localhost:8000/dashboard/apps/`
2. "Install app" → URL del manifest: `http://localhost:3001/api/manifest`
3. El Dashboard llama al manifest, la app responde con `SALEOR_APP_TOKEN` y `SALEOR_APP_ID`.
4. Copiar esos valores al `.env` de la app correspondiente y reiniciar.

---

## Comandos clave

```bash
# Instalar deps
pnpm install

# Dev de una app
pnpm --filter @licona/app-wompi  dev
pnpm --filter @licona/app-envios dev

# Build de producción
pnpm --filter @licona/app-wompi  build
pnpm --filter @licona/app-envios build

# Tests
pnpm --filter @licona/app-wompi  test
pnpm --filter @licona/app-envios test

# Build de todos
pnpm --filter "@licona/*" build
```

---

## Payment App Pattern

Cada app de pasarela implementa **6 webhooks síncronos** de Saleor:

| Webhook | Propósito |
|---|---|
| `PAYMENT_GATEWAY_INITIALIZE_SESSION` | Retorna public key + métodos habilitados |
| `TRANSACTION_INITIALIZE_SESSION` | Crea transacción en la pasarela, retorna redirect URL |
| `TRANSACTION_PROCESS_SESSION` | Pasos adicionales (3DS, redirecciones) |
| `TRANSACTION_CHARGE_REQUESTED` | Captura una autorización |
| `TRANSACTION_REFUND_REQUESTED` | Emite un reembolso |
| `TRANSACTION_CANCELATION_REQUESTED` | Anula una autorización |

Más un webhook **entrante** de la pasarela (ej. `POST /wompi-incoming`) que llama `transactionEventReport` en Saleor.

**Conversión de montos:** Saleor envía COP (ej. `120000`). Wompi espera centavos (`12000000`). Multiplicar por 100 en la app.

---

## Verificación de webhooks

Los webhooks de Saleor hacia las Apps usan **JWS/RS256** (Saleor firma con su RSA privada).
Los webhooks entrantes de pasarelas (Wompi, PayU) usan **HMAC** con su propio secret.

El paquete compartido `packages/webhook-utils` (`@licona/webhook-utils`) expone `verifySaleorWebhook` para JWS. Úsarlo en todos los handlers de webhooks Saleor.

---

## Variables de entorno

Cada app tiene su propio `.env` en `apps/<nombre>/.env`.
Ver `apps/<nombre>/.env.example` para la lista completa.

**Variables comunes a todas las apps:**
- `SALEOR_API_URL` — `http://localhost:8000/graphql/`
- `APP_API_BASE_URL` — URL pública de esta app (para que Saleor llame de vuelta)
- `APL=env` — APL de un solo tenant vía variable de entorno
- `SALEOR_APP_TOKEN` — se obtiene tras instalar la app en el Dashboard
- `SALEOR_APP_ID` — idem

---

## Stack

- Node 22, pnpm workspaces
- Fastify 5 (servidor HTTP para todas las apps)
- TypeScript strict
- `@licona/webhook-utils` (paquete compartido — JWS verification)
