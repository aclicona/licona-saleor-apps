# Conciliación contra el API de Wompi (B-412)

**Por qué:** los reintentos de Wompi son finitos. Si Saleor está caído más que esa ventana, la confirmación
de un pago real se pierde. Ruling: no una cola, sino un proceso periódico **sin estado e idempotente**.

**Qué hace** (`src/lib/conciliacion.ts`): lista las transacciones de la ventana en Wompi y, por cada una con
estado mapeado, llama a `transactionEventReport` con el mismo contrato del webhook entrante (mismo
`WOMPI_TO_SALEOR`, que se importa y **no se modifica**; mismo `centsToCop`; `pspReference` = id Wompi).
Saleor deduplica: `alreadyProcessed` → nada cambia; si faltaba → se crea y se registra un `warn` (señal de una
entrega perdida). Un fallo del API de Wompi o de una transacción se registra y la corrida sigue; la próxima
reintenta. Referencias ajenas, importes corruptos y rechazos de negocio siguen la misma regla de severidad
que el webhook (`fatal` solo con dinero en riesgo).

## Cómo encenderlo

Apagado por defecto: la ruta no existe (404).

1. `WOMPI_CONCILIACION_HABILITADA=true` y `WOMPI_CONCILIACION_TOKEN=<secreto largo>` (ambas obligatorias).
2. Opcional: `WOMPI_CONCILIACION_VENTANA_MINUTOS` (default 1440, máx. 10080).
3. Opcional: `WOMPI_CONCILIACION_INTERVALO_MINUTOS` (default 15, máx. 1440; `0` apaga el temporizador).
4. Disparo automático: con la conciliación habilitada, un **temporizador en proceso** (`src/lib/conciliacion-periodica.ts`)
   corre la primera vez 30 s tras arrancar y luego cada N min (se re-arma al terminar; nunca se solapa).
   Salta la corrida, con `warn`, si la App no está registrada en Saleor o si ya hay otra conciliación en curso
   (candado en memoria compartido con el endpoint). Un fallo de una corrida se registra y no tumba el proceso.
   Cada corrida del temporizador loguea con `disparador: "timer"`; la del endpoint con `disparador: "http"`.
   Un intervalo mayor que la mitad de la ventana emite `warn` al arrancar.
5. Disparo manual con `POST /api/conciliacion/ejecutar` y `Authorization: Bearer <token>`. Responde 200 con el
   resumen (`revisadas, yaReportadas, reportadas, sinMapeo, omitidas, errores`), 502 si falló el API de Wompi,
   401 sin token válido, 409 `{ error: 'Conciliación en curso' }` si ya hay una corrida en este proceso.

**Réplicas múltiples:** el candado es por proceso. Con N réplicas habrá N corridas por intervalo; es inocuo
(Saleor deduplica por `pspReference` + tipo + importe) y se acepta.

## Solicitudes pendientes (B-1083)

Tras el bucle de transacciones, la misma corrida cierra las **anulaciones que quedaron pendientes** en Saleor
(`transaction-cancel` respondió sin `result` por un fallo de red y dejó el `CANCEL_REQUEST` abierto).

- **Qué hace:** consulta a Saleor las transacciones con un `CANCEL_REQUEST` creado dentro de la ventana y
  `cancelPendingAmount > 0`; por cada request sin cierre pregunta a Wompi (`GET /transactions/{psp}`) y reporta
  `CANCEL_SUCCESS` (`VOIDED`) o `CANCEL_FAILURE` (`APPROVED` pasado el margen). Reglas en `wompi-estados.md`.
  Reporta con el `pspReference` y el importe del request (no los de Wompi); si difieren, `warn`.
- **Por qué se consulta Saleor y no el listado de Wompi:** la fecha del request no es la de la transacción; una
  venta de hace días puede anularse hoy y el listado por fecha de creación no la vería.
- **Resumen:** clave opcional `anulaciones` en el resultado y en el log «Conciliación terminada», con
  `candidatas, cerradasExito, cerradasFallo, yaCerradas, enEspera, sinDecidir, errores, errorApi`. Un fallo de
  Saleor aquí (`anulaciones.errorApi`) no cambia el código HTTP.
- **Requisitos:** Saleor ≥ 3.23 (filtro `events` de `transactions`); basta el permiso `HANDLE_PAYMENTS` (la App ve
  solo sus transacciones).
- **Límites:** un request más viejo que la ventana no se ve; se leen como máximo 5 páginas de 50 (hay `warn` al
  llegar al tope). Idempotente: al cerrarse deja de ser candidata y un duplicado da `alreadyProcessed`.

### Reembolsos pendientes (B-1077)

Mismo motor, tras las anulaciones y antes del log final: cierra los `REFUND_REQUEST` que quedaron abiertos
(`transaction-refund` respondió sin `result`). Consulta `GET /refunds/{psp}` (`politicaReembolsos`) y reporta
`REFUND_SUCCESS` (`APPROVED`) o `REFUND_FAILURE` (`DECLINED`/`ERROR`/`VOIDED`); `PENDING` espera 60 min
(`MARGEN_REEMBOLSO_PENDIENTE_MIN`) y después queda para revisión humana, nunca como fallo. Resumen en la clave
opcional `reembolsos` (misma forma que `anulaciones`); un `errorApi` de anulaciones no impide que corran.

- **Sin id:** un request con psp `<pspTx>:reembolso-sin-id:<uuid>` se casa contra `refunds[]` de
  `GET /transactions/{pspTx}` por importe y fecha (B-1097, ver «Reembolsos sin id» abajo). Lo ambiguo queda en
  `log.error` (`estadoWompi`: `SIN_ID_AMBIGUO`, `CANDIDATOS_MULTIPLES`, `CONOCIDO_NO_CONSULTABLE`, `SIN_CANDIDATOS`
  vencido, `HTTP_404`) para revisión humana.

### Reembolsos sin id (B-1097)

#### Evidencia del sandbox (2026-10-09)

Probado con transacción APPROVED de sandbox y dos `POST /refunds` del mismo importe:

| Petición | HTTP | Resultado |
|---|---|---|
| `GET /refunds?transaction_id=…` (con y sin `page`/`page_size`), `GET /refunds`, `GET /refunds?from_date&until_date`, `GET /refunds?reference=…` | 404, cuerpo vacío | no existe listado de reembolsos |
| `GET /transactions/{id}/refunds`, `GET /transactions/{id}/refund` | 404, cuerpo vacío | no existe |
| `GET /refunds/{id}` | 200 | `data`: `id, created_at, transaction_id, status, amount_in_cents, status_message, external_identifier, is_sandbox, sandbox_test_scenario, cancelled_at` |
| `GET /transactions/{id}` | 200 | `data.refunds[]` embebido, cada item solo `created_at, transaction_id, status, amount_in_cents, status_message` (**sin `id`**); el `status` se actualiza (`PENDING` → `APPROVED`) |

| Comparación de `created_at`: `GET /refunds/{id}` vs item embebido de `GET /transactions/{id}` (reembolsos 31180 y 31181 de la transacción `12084641-1791526992-27837`) | 200 / 200 | **Idénticos al milisegundo**, como string literal y como `Date.parse`: 31180 → `"2026-10-09T06:23:16.472Z"` (1791526996472) en ambos; 31181 → `"2026-10-09T06:23:20.768Z"` (1791527000768) en ambos. Mismos `amount_in_cents` (1000000). Verificado el 2026-10-09 |

El objeto refund SÍ trae `created_at`. El embebido no trae `id`: por eso la exclusión de los reembolsos ya conocidos
se hace por `created_at` exacto (regla 3 del ruling).

#### Ruling (Fable, 2026-10-09, B-1097) — literal

**RULING (Fable, 2026-10-09, B-1097)** Sí: se implementa el casado contra `refunds[]` de `GET /transactions/{pspTx}`. Motivo: el riesgo de decidir mal queda acotado por la exclusión *exacta* de los conocidos y por la regla «ambigüedad → humano»; el beneficio es cerrar en automático el caso normal (un solo reembolso de ese importe). Nunca se adivina.
1. **Alcance.** Solo requests con psp `<pspTx>:reembolso-sin-id:<uuid>`. `pspTx` = prefijo antes del separador. `GET /transactions/{pspTx}` → 404 → `sin-decidir` (`HTTP_404`); otro error → propagar (cuenta en `errores`, reintenta la próxima corrida), igual que hoy.
2. **Candidatos.** Items de `refunds[]` con `amount_in_cents` igual al importe del request (misma conversión existente, `centsToCop(item) === s.importeCop`) y `created_at` ∈ `[creadaEn − 2 min, creadaEn + PLAZO_GLOBAL_MS + 2 min]`. Fechas como epoch ms (`Date.parse`), nunca string; un `created_at` que no parsea → el item no cuenta.
3. **Exclusión de conocidos — por `created_at` exacto, no por conteo.** Conocidos = psp con id real (no sin-id) de todos los eventos `REFUND_REQUEST/SUCCESS/FAILURE` de la transacción en Saleor, deduplicados, restringidos a los del mismo importe del request. Por cada uno, `GET /refunds/{id}` y se descarta el candidato cuyo `created_at` (epoch ms) y `amount_in_cents` coincidan exactamente. Un conocido que no se puede consultar (404 o error) → `sin-decidir` (`estadoWompi: CONOCIDO_NO_CONSULTABLE`); no se descuenta por conteo.
4. **Ambigüedad previa.** Si en la misma transacción hay ≥ 2 requests sin-id abiertos del mismo importe, todos → `sin-decidir` sin consultar nada.
5. **Decisión sobre el único candidato restante** (misma tabla que con id): `APPROVED` → éxito; `DECLINED`/`ERROR`/`VOIDED` → fallo (mensaje fijo, nunca `status_message`, B-1061); `PENDING` dentro del margen (60 min) → esperar; `PENDING` vencido u otro estado → `sin-decidir`.
6. **0 candidatos:** dentro del margen → esperar; vencido → `sin-decidir`. **> 1 candidato:** `sin-decidir` de inmediato.
7. **Cierre.** Se reporta con el `pspReference` sin-id del request y su importe, `message` indicando que fue casado por importe y fecha sin id, y `log.warn` con `created_at` del item y los ids excluidos, para auditoría.
Riesgos: aceptado dos reembolsos del mismo importe con created_at idéntico al ms; rechazado cerrar como fallo con 0 candidatos. Si el API añade `id` al embebido, el paso 3 pasa a exclusión por id.

Implementación: `lib/decision-reembolso.ts` (casado y tabla de estados), `lib/refunds-embebidos.ts` (validación de la
forma del dato externo; un item mal formado no cuenta). El `log.warn` de cierre lleva `casadoSinId: { createdAt, idsExcluidos }`
(`idsExcluidos` = conocidos que efectivamente descartaron un candidato).

**Extensión conservadora (orquestador, revisión pre-merge 2026-10-09).** Hueco de la regla 4: un request sin-id YA
CERRADO no excluye su reembolso. Ejemplo: A (sin-id, importe X) se casó con R1 y quedó `REFUND_SUCCESS`; después B
(sin-id, mismo X, cuyo reembolso nunca se creó) tiene una ventana que contiene a R1, así que R1 sería su único
candidato y B se cerraría como éxito sin dinero devuelto. Como el embebido no trae `id`, no se puede saber que R1 ya
es de A. Regla añadida (solo agrega `sin-decidir`): si en la transacción existe OTRO psp sin-id del mismo importe en
cualquier evento `REFUND_REQUEST/SUCCESS/FAILURE` (abierto o cerrado, distinto del actual) cuya ventana de casado
(calculada con el `createdAt` de su `REFUND_REQUEST`) se solape con la del request actual, este queda en
`sin-decidir` (`SIN_ID_AMBIGUO`) sin consultar a Wompi. Si del otro no se ve su `REFUND_REQUEST`, se asume solapado.
Además, los conocidos se limitan a `REFUND_REQUEST/SUCCESS/FAILURE` (no `REFUND_REVERSE`).

## Prueba de contrato contra el sandbox (B-1100)

Los reembolsos sin id (B-1097) dependen de hechos que NO están en la doc pública de Wompi y se midieron en sandbox
el 2026-10-09. Si Wompi los cambia, la exclusión de conocidos fallaría en silencio. La prueba de contrato los vigila.

**Qué comprueba** (crea una transacción de 50.000 COP en sandbox con la tarjeta de prueba, hace 2 reembolsos
parciales de 10.000 COP, espera unos segundos y lee):
1. `GET /transactions/{id}` trae `refunds[]` y cada item trae `created_at` (parseable), `amount_in_cents` y `status`.
2. Cada `GET /refunds/{id}` tiene un único gemelo en `refunds[]` con el mismo `created_at` y el mismo importe.
   Se compara como **epoch ms (`Date.parse`)**, no como texto: es exactamente lo que hace la conciliación
   (`refunds-embebidos.ts`), así que una diferencia solo de formato (`.472Z` vs `.472000Z`) no es rojo.
3. `GET /refunds?transaction_id=` y `GET /transactions/{id}/refunds` siguen respondiendo 404. Si dejan de hacerlo, la
   causa `listado_disponible:<ruta>:<http>` avisa de que ya se podría excluir por id (rojo para que alguien lo mire).

**Cómo correrla** (desde `apps/wompi`, con `.env` de sandbox):

```sh
pnpm contrato:sandbox
```

Imprime UNA línea TSV `<estado>\t<causas|->\t<fecha ISO>\t<detalle>` y sale con 0 (verde), 1 (rojo) o 2 (sin_medida:
red, llaves ausentes, 401, transacción no aprobada). Guarda dura: si `WOMPI_PRIVATE_KEY` no empieza por `prv_test_` o
`WOMPI_PUBLIC_KEY` por `pub_test_`, no llama a nada (nunca contra producción). Nunca imprime llaves ni headers.
Lógica de decisión (pura, con tests): `src/lib/contrato-sandbox.ts`; script: `scripts/contrato-sandbox.ts`.

**Qué hacer en rojo:** no tocar la conciliación a ciegas. Releer la causa, repetir la prueba una vez (descartar
latencia), y si persiste, reabrir el ruling de B-1097 (regla 3: exclusión de conocidos por `created_at` exacto) con la
nueva forma del API. `sin_medida` no es un veredicto: repetir más tarde.

**Estado:** aún no está programada (se corre a mano). Programarla periódicamente queda pendiente.

## Quién lee los “requiere revisión humana” (B-1090)

El vigilante `scripts/railway-seguro/revision_humana_wompi.py` (repo raíz de ecommerce) corre al apagar licona-store
(`railway_seguro.py --ejecutar`; avisa, no bloquea) y lee los logs de app-wompi de la ventana: es hallazgo toda línea
cuyo `message` contiene «revisión humana» (sin distinguir mayúsculas).

- **Regla:** todo aviso para humanos lleva el literal «revisión humana». `src/lib/revision-humana.contract.test.ts`
  lo exige a cada `log.fatal` y `registrar.call(log, …)`, y a cada `log.error` de `conciliacion*.ts` (si no es humano,
  debe ser transitorio —«La próxima corrida reintenta»— o estar en la lista de excepciones del test, con su porqué).
- **El nivel no sirve para filtrar:** Railway aplana el JSON de pino y muestra `level: info` en todo (medido el
  2026-10-06: los `log.error` «Saleor rechazó el evento… requiere revisión humana» salieron como info; `@level:error`
  devuelve vacío). No es que se logueen a info: es el transporte. Por eso el marcador va en el texto. Esto corrige la
  lectura de B-944 §2 si sugería buscar por nivel.
- Fuera del contrato (a propósito): los `log.error` de `wompi-incoming.ts` no son de conciliación y no los cubre el
  chequeo de `log.error`; sus `log.fatal` sí.

## Decisiones pendientes (Andrés)

| Tema | Opciones | Recomendación |
|---|---|---|
| Frecuencia | cada 5 min / 15 min / horaria | cada 15 min (default de `WOMPI_CONCILIACION_INTERVALO_MINUTOS`): acota la pérdida a minutos con coste bajo (Saleor deduplica) |
| Ventana | 1 h / 24 h / 7 d | 24 h (default), siempre ≥ 2× la frecuencia y ≥ la caída máxima tolerada de Saleor |
| Credenciales | llave privada Wompi ya existente / llave de solo lectura (si Wompi la ofrece) + token propio del endpoint | reutilizar la privada; token del endpoint distinto, rotado desde el aprovisionamiento |
| Disparador | **Decidido** (B-412, Andrés 2026-10-07 + ruling de Fable): temporizador en proceso dentro de app-wompi, sin servicio nuevo; corre solo mientras el servicio está vivo | — |
| Margen de anulaciones pendientes (B-1083) | 15 / 60 / 240 min | hoy 60 (`MARGEN_ANULACION_PENDIENTE_MIN`). Seguro: un `VOIDED` tardío tras un `CANCEL_FAILURE` sigue des-pagando con `CHARGE_FAILURE` |
| Margen de reembolsos pendientes (B-1077) | 15 / 60 / 240 min | hoy 60 (`MARGEN_REEMBOLSO_PENDIENTE_MIN`). Vencido no cierra como fallo: pasa a revisión humana |
| Reembolsos sin id (B-1077, B-1097) | revisión humana / casado contra `refunds[]` embebido | **Decidido (Fable, 2026-10-09): casado automático** con las reglas del ruling; ambigüedad → humano. Listado dedicado de reembolsos: confirmado que NO existe. Revisar si Wompi añade `id` al embebido (exclusión por id) |
| `availableActions` tras `CANCEL_FAILURE` | `[]` / `['REFUND']` | hoy `[]`: deja Refund apagado. ¿`['REFUND']`? |

## Pendiente de verificación humana

- **El endpoint de listado de Wompi no está verificado**: `WompiClient.listTransactions` asume
  `GET /transactions?from_date&until_date&page&page_size` con llave privada y `meta.total_pages`. Probar en el
  sandbox antes de encender; si difiere, solo cambia ese método.
- Un `VOIDED` re-reportado como `CHARGE_FAILURE` revierte el cobro en Saleor (ver `wompi-estados.md`); requiere
  Saleor vivo para confirmarlo.
