# saleor-apps

> **Proceso:** Las reglas de desarrollo no negociables están en `../CLAUDE.md` (sección "Proceso de Desarrollo"). Leerlas antes de cualquier sesión. En resumen: planear antes de codificar, consultar antes de decidir, usar skills y agentes de ECC (`ecc:*`), validar exhaustivamente antes de reportar éxito.


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

`build` compila con `tsconfig.build.json` (excluye `*.test.ts`, así `dist/` y la imagen de
producción no llevan tests). `tsconfig.json` sí los incluye: `pnpm typecheck` los verifica.
**CI:** `.github/workflows/ci.yml` corre en cada PR y push a `main`: `pnpm install --frozen-lockfile`,
`pnpm -r build` (`webhook-utils` debe compilarse antes que las Apps), `pnpm typecheck` y `pnpm test`.
Node sale de `.nvmrc` y pnpm de `packageManager`. No despliega. Para reproducirlo en local, ejecutar
esos cuatro comandos en ese orden.
**Logging en `apps/envios`:** el handler de envíos usa el mismo patrón que los de wompi: `req.log.child`
con `webhook` y las claves canónicas de correlación (`checkoutId`, en `lib/correlacion.ts`), y los
fallos de firma se escriben como `log.warn({ motivo: err.reason }, err.message)` — no con `msg` dentro
del objeto.
**Dockerfiles:** `--frozen-lockfile` exige los manifiestos de TODAS las Apps del workspace, y Docker
no permite globs que conserven directorios, así que cada `Dockerfile` los lista a mano. Al añadir una
App hay que añadirla en los de las demás; `pnpm check:dockerfiles` falla si falta alguna (conviene
incluirlo en CI).
**Subscriptions del manifiesto (B-382):** las `query` de suscripción son texto crudo que nada compila.
`pnpm check:subscriptions` (tras `pnpm -r build`) las valida con `graphql.validate` contra el esquema del
fork, cuya ruta se pasa en `SALEOR_SCHEMA_PATH`; sin la variable se omite (exit 0), con `--requerido` falla.
Los manifiestos viven en `apps/*/src/manifest.ts` (`construirManifiesto`). Falta publicar el esquema versionado
del fork y fijar la variable en CI.
**Deriva del manifiesto (B-406):** Saleor congela la `query` de suscripción al instalar la App. Al arrancar
(con `SALEOR_APP_TOKEN` presente), cada App compara su `/api/manifest` vivo con los webhooks que Saleor tiene
registrados (`app { webhooks { … } }`) y escribe un log `error` con la deriva si difieren
(`avisarDerivaAlArranque`, `packages/webhook-utils/src/deriva.ts`). Solo detecta: no repara ni bloquea el
arranque. El resultado (`sano`/`deriva`/`desconocido`/`sin_comprobar`, `crearSeguimientoDeriva`) se refleja en los healthchecks:
`/api/health` (wompi) pasa a `status:'degraded'` con `deriva.detalle` legible pero **sigue en 200** (reiniciar no arregla la
deriva, hay que reinstalar); `/api/health/ready` (wompi y envios) responde **503** con `checks.deriva`. Una falla de consulta
a Saleor es `desconocido`: no es rojo, solo se loguea (`warn`). La comprobación del arranque nunca rechaza
(`comprobarDerivaDesdeManifiesto`). Supuesto del productor: la query `app { webhooks { … } }` no se validó contra el fork. La consulta a Saleor está probada con dobles, no contra el fork.
**Healthchecks (B-407):** cada App expone dos, con propósito distinto. `GET /api/health` (solo wompi)
es de *vida*: barato, sin red, 200 incluso en modo degradado — es el que puede usar el orquestador.
`GET /api/health/ready` (wompi y envios) es de *cadena*: config presente, Saleor alcanzable (POST
`{ __typename }`) y JWKS descargable con claves; **503** con el detalle por eslabón si falla uno.
Hace red con timeout de 3 s, así que es para monitoreo/alertas externas, **no** como liveness probe
(mataría la App antes de que Saleor le entregue el token). Lógica compartida:
`verificarCadena` en `packages/webhook-utils/src/salud.ts` (fetch inyectable, probada con dobles).

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

**Referencia a Wompi (B-397):** `referenciaParaWompi` (`apps/wompi/src/lib/referencia.ts`) es la identidad
por defecto (ID global de 72 caracteres terminado en `==`, nunca validado contra Wompi, que documenta
referencias alfanuméricas). Con `WOMPI_REFERENCIA_CODIFICADA=true` emite base64url sin relleno; la inversa
acepta ambos formatos. Activar solo tras probar en sandbox de Wompi.

**Conciliación (B-412):** backstop sin estado e idempotente contra el API de transacciones de Wompi
(`apps/wompi/src/lib/conciliacion.ts`): re-reporta a Saleor lo que falte; Saleor deduplica. **APAGADO por
defecto** (`WOMPI_CONCILIACION_HABILITADA`); sin cron cableado. Cómo encenderlo y decisiones pendientes:
`apps/wompi/docs/conciliacion.md`.

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
