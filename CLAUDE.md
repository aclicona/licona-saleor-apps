# saleor-apps

> **Proceso:** Las reglas de desarrollo no negociables están en `../CLAUDE.md` (sección "Proceso de Desarrollo"). Leerlas antes de cualquier sesión. En resumen: planear antes de codificar, consultar antes de decidir, usar skills de Superpowers/ECC, validar exhaustivamente antes de reportar éxito.


Monorepo pnpm de Saleor Apps para el e-commerce colombiano. Cada app es un microservicio independiente que se comunica con Saleor via webhooks síncronos (JWS/RS256).

**Contexto de proyecto completo:** `../CLAUDE.md` (o abre `ecommerce/` en Claude Code).

> **Graph:** Este repo tiene knowledge graph (`code-review-graph`, MCP en `.mcp.json`). Para preguntas estructurales (callers, imports, radio de impacto) usarlo ANTES que Grep/Read. Se actualiza solo en cada commit/merge vía `.git/hooks/post-*`; tras editar sin commitear, ejecutar `build_or_update_graph_tool`. Detalles en `../CLAUDE.md` §"El graph".

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
1. Ir a `http://localhost:9000` (Dashboard Docker)
2. "Install app" → URL del manifest: `http://127.0.0.1:3001/api/manifest`
   ⚠️ Usar `127.0.0.1` y NO `localhost` — en macOS `localhost` resuelve a `::1` (IPv6) y el proceso Node solo escucha en IPv4.
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

**Conversión de montos:** Saleor envía COP (ej. `120000`), Wompi espera centavos (`12000000`).
**No multiplicar a mano** — usar `copToCents` / `centsToCop` (`apps/wompi/src/lib/money.ts`, cubiertas
por tests desde 2026-08-22). Redondean explícitamente: en IEEE-754 `19.99 * 100` da
`1998.9999999999998`, y Saleor almacena importes con 3 decimales, así que el número que llega puede
no ser un entero limpio. Ante un importe inválido **lanzan**, en vez de dejar pasar un cobro
equivocado en silencio.

---

## Verificación de webhooks

Los webhooks de Saleor hacia las Apps usan **JWS/RS256** (Saleor firma con su RSA privada).

El paquete compartido `packages/webhook-utils` (`@licona/webhook-utils`) expone `verifySaleorWebhook` para JWS. Úsarlo en todos los handlers de webhooks Saleor.

⚠️ **Los webhooks entrantes de las pasarelas NO son HMAC — al menos Wompi no lo es.** Esta línea
decía "usan HMAC con su propio secret" y **era falsa**; indujo una implementación equivocada que se
corrigió el 2026-08-22 (ver [bitácora](../docs/hardening/sessions/2026-08-22-idempotencia-y-firma-wompi.md)).
Cada pasarela define su propio esquema y **hay que leer su documentación, no asumir**.

**Wompi** (verificado contra https://docs.wompi.co/en/docs/colombia/eventos/):
- **SHA-256 simple**, no HMAC.
- Se firma la concatenación **sin separadores** de los *valores* de las propiedades que el propio
  evento lista en `signature.properties`, seguidos de `signature.timestamp` y del **secreto de
  eventos** (distinto de la llave de integridad, que firma la *creación* de transacciones).
- `signature.properties` **varía entre eventos**: hay que leer la lista de cada evento, nunca
  codificarla fija.
- El checksum viaja en la cabecera `X-Event-Checksum` **y** en `signature.checksum` (son copias).
  **No** existen las cabeceras `x-signature` ni `x-event-created-at`.
- Implementación y tests: `apps/wompi/src/lib/wompi-signature.ts`.

**Al integrar PayU o MercadoPago, verificar su esquema en la documentación del proveedor antes de
escribir una línea** — y no reutilizar el de Wompi por parecido.

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
