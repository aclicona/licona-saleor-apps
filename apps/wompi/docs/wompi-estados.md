# Estados de transacción de Wompi y su mapeo a Saleor

Fuente: https://docs.wompi.co/en/docs/colombia/ (estados de transacción). Mapeo implementado en
`src/webhooks/wompi-incoming.ts` (`WOMPI_TO_SALEOR`) y `src/webhooks/transaction-process.ts`
(`WOMPI_STATUS_MAP`).

| Estado Wompi | Significado | Evento Saleor (entrante) | Respuesta de `transaction-process` |
|---|---|---|---|
| `PENDING` | En curso (PSE/Nequi por confirmar) | sin mapeo: 200 + log `info` | `CHARGE_ACTION_REQUIRED` |
| `APPROVED` | Cobro aprobado | `CHARGE_SUCCESS` | `CHARGE_SUCCESS` |
| `DECLINED` | Rechazado por el medio de pago | `CHARGE_FAILURE` | `CHARGE_FAILURE` |
| `ERROR` | Error al procesar | `CHARGE_FAILURE` | `CHARGE_FAILURE` |
| `VOIDED` | Anulada tras aprobarse | `CHARGE_FAILURE` | `CHARGE_FAILURE` |
| *(la consulta falla: timeout, red, 5xx)* | Estado desconocido | — | `CHARGE_ACTION_REQUIRED` con `pspReference` (B-1057) |

## Por qué un fallo al consultar no es `CHARGE_FAILURE` (B-1057)

`CHARGE_FAILURE` es un evento **final** en Saleor: tras él, `transactionProcess` ya no vuelve a llamar a la
App. Si `getTransaction` lanza, el estado en Wompi es desconocido, no un rechazo; responder fallo dejaría la
transacción marcada como fallida aunque Wompi terminara aprobando. Se responde `CHARGE_ACTION_REQUIRED`
(como `PENDING`) y lo resuelven el siguiente `transactionProcess`, el webhook entrante o la conciliación
(`docs/conciliacion.md`). El texto del error va solo al log, nunca en el `message` hacia Saleor.
`CHARGE_FAILURE` se reserva para el payload sin `pspReference` (no hay nada que consultar).

## Por qué `VOIDED → CHARGE_FAILURE` (B-411)

Parece que debería ser `CANCEL_SUCCESS`, pero sería una **regresión**: dejaría la orden pagada tras un
void. Un `VOIDED` llega después de un `APPROVED` de la misma transacción de Wompi, es decir con el mismo
`pspReference`; el `CHARGE_FAILURE` posterior sobre ese `pspReference` revierte el `CHARGE_SUCCESS` previo.

Dependencia no obvia: el `pspReference` (id de la transacción en Wompi) debe coincidir entre ambos eventos.
Lo fija el test «secuencia APPROVED → VOIDED» en `src/webhooks/wompi-incoming.test.ts`.

> Pendiente de verificación humana: que Saleor (fork) revierta efectivamente el cobro con esa secuencia
> requiere un Saleor vivo; aquí solo se prueba el contrato del reporte (tipo + pspReference).

## Contrato transversal: «estado desconocido ≠ rechazo» (B-1061)

Ningún handler síncrono `transaction-*` puede convertir un fallo de transporte hacia Wompi (`AbortError`,
`TimeoutError`, `TypeError: fetch failed`, 5xx) en un resultado **final** de fallo (`*_FAILURE`) cuando la
transacción o el reembolso pudo haberse creado ya en Wompi: el estado es desconocido, no un rechazo, y Saleor
no vuelve a preguntar tras un evento final. Además, el `message` hacia Saleor **nunca** contiene el texto del
error (va solo al log). Un 4xx de Wompi sí es un rechazo cierto y sigue siendo `*_FAILURE`.

Lo vigila `src/webhooks/contrato-desconocido.test.ts`: una tabla handler × llamada que falla × tipo de fallo, y
una aserción que enumera los `transaction-*.ts` del directorio y falla si falta alguno en la tabla (al añadir un
handler hay que darlo de alta ahí).

Excepciones conocidas (el test exige que la violación **siga** ocurriendo; al arreglarla se pone rojo y hay que
quitar la entrada de `EXCEPCIONES`): ninguna.

Cumplen: `transaction-initialize` (B-1060, ver abajo), `transaction-process` (B-1057), `transaction-refund` (B-1071, ver abajo), `transaction-cancel` (B-1072, ver «Anulaciones») y `transaction-charge` (no llama a Wompi). `payment-gateway-initialize` no
es `transaction-*` y solo lee la llave pública, sin red.

## Inicio: fallo de transporte ≠ `CHARGE_FAILURE` (B-1060)

`CHARGE_FAILURE` es final en Saleor. En `transaction-initialize` hay dos fases: `token` (acceptance token; aún no
existe nada en Wompi) y `crear` (la transacción pudo crearse aunque la respuesta no llegue). Los mensajes hacia
Saleor son fijos; el texto del error va solo al log.

| Situación | Respuesta |
|---|---|
| Cualquier fallo al obtener el acceptance token (fase `token`) | `CHARGE_FAILURE`, `message` fijo («No se pudo iniciar el pago con Wompi») |
| Wompi devuelve 4xx al crear, excepto 408/429 (422 referencia duplicada, 400 token inválido...) | `CHARGE_FAILURE`, `message` fijo («Wompi rechazó la transacción») |
| Timeout/plazo, `fetch failed`, 5xx, 408/429 al crear | `CHARGE_ACTION_REQUIRED` sin `pspReference` ni `data`, `actions` vacío, `message` fijo («Estado en Wompi desconocido...»). Log `warn` si fue el plazo, `error` si no |

Esquema de Saleor (fork): en `TransactionSessionActionRequiredSchema` el `psp_reference` es **opcional**;
`CHARGE_REQUEST` lo exige (no sirve aquí) y `result` es obligatorio en la sesión (omitirlo acaba en evento fallido).
Por eso se usa `CHARGE_ACTION_REQUIRED` sin `pspReference`.

**Rescate:** la transacción huérfana se resuelve por `reference` (el id de transacción de Saleor): el webhook de
Wompi (`wompi-incoming.ts`) y la conciliación (`conciliacion.ts`) casan por `reference`, no por `pspReference`.

**Storefront:** con `CHARGE_ACTION_REQUIRED` sin `redirectUrl`, `pago.vue` muestra INCOMPLETE_RESPONSE y conserva
la `idempotencyKey`.

**Trampa del reintento (seguimiento pendiente):** si el comprador reintenta con la misma `idempotencyKey` y la
transacción huérfana existe en Wompi, éste responde 422 «referencia duplicada» → `CHARGE_FAILURE`. No se pierde
dinero (el webhook acredita por `reference`) pero el comprador queda en bucle. Pendiente: buscar por `reference`
en Wompi tras verificar el filtro en el sandbox.

## Anulaciones: fallo de red ≠ `CANCEL_FAILURE` (B-1072)

`CANCEL_FAILURE` es final en Saleor. En `transaction-cancel`:

| Situación | Respuesta |
|---|---|
| Sin `pspReference` en el payload | `CANCEL_FAILURE`, `message` fijo («Sin pspReference») |
| Wompi devuelve 4xx de validación (excepto 408/429) | `CANCEL_FAILURE`, `message` fijo («Wompi rechazó la solicitud de anulación») |
| Timeout, `fetch failed`, 5xx, 408/429 | sin `result`, `pspReference` = el de la transacción (respuesta asíncrona: deja `CANCEL_REQUEST`, no final) |
| `CANCEL_REQUEST` que quedó pendiente → lo cierra la conciliación (B-1083) | Wompi `VOIDED` → `CANCEL_SUCCESS`; `APPROVED` pasado el margen (`MARGEN_ANULACION_PENDIENTE_MIN`, 60 min desde el request) → `CANCEL_FAILURE` con `message` fijo («La anulación no se aplicó en Wompi (sigue APPROVED pasado el margen)»); `APPROVED` dentro del margen → se espera; cualquier otro estado → no se decide, `log.error` y revisión humana. Se reporta con el mismo `pspReference` e importe del request |

La anulación pudo aplicarse en Wompi, por eso el estado desconocido no se cierra como fallido. Se concilia
(`docs/conciliacion.md` → «Solicitudes pendientes»). El texto del error va solo al log.

## Reembolsos: fallo de red ≠ `REFUND_FAILURE` (B-1071)

`REFUND_FAILURE` es final en Saleor. En `transaction-refund`:

| Situación | Respuesta |
|---|---|
| Wompi devuelve 4xx de validación al crear (excepto 408/429) | `REFUND_FAILURE`, `message` fijo («Wompi rechazó la solicitud de reembolso») |
| Reembolso `DECLINED`/`ERROR`/`VOIDED` | `REFUND_FAILURE` con `status_message` de Wompi |
| Timeout, `fetch failed`, 5xx, 408/429 al crear, o Wompi responde sin `id` | sin `result`, `pspReference` = `<pspReference de la transacción>:reembolso-sin-id:<uuid>` (único por petición) |
| Cualquier fallo al sondear `getRefund` tras crear | sin `result`, `pspReference` = id del reembolso |
| `PENDING` tras el sondeo | sin `result`, `pspReference` = id del reembolso |

Saleor (`saleor/webhook/response_schemas/transaction.py`, `payment/utils.py::_validate_transaction_action_data`)
no admite `REFUND_REQUEST` como `result` síncrono: los valores válidos son `REFUND_SUCCESS` y `REFUND_FAILURE`;
un `result` ausente + `pspReference` (obligatorio) se trata como respuesta asíncrona y deja el evento
`REFUND_REQUEST`, no final. Sin `pspReference` Saleor registraría un `REFUND_FAILURE`, por eso el timeout en la
creación (sin id de reembolso) usa una referencia única por petición. No se reutiliza la de la transacción: Saleor
guarda un único `request` por `pspReference` (`transaction_item_calculations.py`), así que dos reembolsos pendientes
con la misma referencia contarían como uno y `charged_value` quedaría mal. Ese caso **solo se concilia buscando en
Wompi los reembolsos de la transacción**: la referencia generada no casa con ningún id real. El texto del error va solo al log.

### Plazo global de 15 s (B-1078)

`PLAZO_GLOBAL_MS` vive en `src/lib/plazo.ts`. Aplica también a `transaction-initialize` (firma + token + crear, B-1060), con la misma señal para ambas llamadas.

Saleor espera 18 s la respuesta síncrona del webhook y, pasado ese tiempo, registra `REFUND_FAILURE`
(«Failed to delivery request.») aunque el reembolso ya exista en Wompi. Cada llamada a Wompi tiene su propio timeout
de 15 s (`TIMEOUT_WOMPI_MS`), así que crear + esperar + sondear podía sumar más de 18 s. `transaction-refund` fija un
plazo global `PLAZO_GLOBAL_MS` = 15 000 ms (margen de ~3 s) que **cuenta desde la llegada de la petición** (incluye la verificación de la firma, cuya descarga del JWKS puede tardar hasta 5 s) con una única `AbortSignal` que se pasa a
`refundTransaction` y `getRefund` (el cliente la combina con su timeout propio: gana el que venza primero):

- Plazo agotado **durante la creación**: sin `result`, `pspReference` sin-id (camino no final de B-1071), nunca `REFUND_FAILURE`.
- Plazo agotado **después de crear** (sondeo colgado): sin `result`, `pspReference` = id del reembolso.
- Plazo ya agotado por la verificación **antes de crear**: no se llama a Wompi (aún no hay nada creado); sin `result` y `pspReference` sin-id.
- Si tras crear quedan ≤ 1,5 s de plazo, se omiten la espera y el sondeo y se responde no final con el id conocido.

**Cierre por conciliación (B-1077):** un `REFUND_REQUEST` que quedó pendiente lo cierra la conciliación con
`GET /refunds/{pspReference}` (`politicaReembolsos`, margen `MARGEN_REEMBOLSO_PENDIENTE_MIN` = 60 min desde el request):

| Estado del reembolso en Wompi | Resultado |
|---|---|
| `APPROVED` | `REFUND_SUCCESS`, `message` fijo «Wompi: reembolso confirmado (APPROVED)» |
| `DECLINED` / `ERROR` / `VOIDED` | `REFUND_FAILURE`, `message` fijo «Wompi no aprobó el reembolso (ESTADO)» (nunca el `status_message` de Wompi, B-1061) |
| `PENDING` dentro del margen | se espera |
| `PENDING` vencido, otro estado o `404` | no se decide: `log.error` y revisión humana (un `PENDING` puede aprobarse después; no se cierra como fallo) |

Se reporta con el mismo `pspReference` e importe del request; si el importe de Wompi difiere, `warn`.

**Caso sin id (B-1097):** si el request lleva `pspReference` `<psp>:reembolso-sin-id:<uuid>` (no se llegó a conocer
el id del reembolso), la conciliación lo casa contra `refunds[]` de `GET /transactions/{psp}` por importe y fecha,
excluyendo por `created_at` exacto los reembolsos ya conocidos. Wompi NO tiene endpoint de listado de reembolsos
(confirmado en sandbox el 2026-10-09; `GET /refunds?transaction_id=…` y variantes dan 404) y el embebido no trae `id`.
Un único candidato se decide con la misma tabla que el caso con id (mensaje con «casado por importe y fecha, sin id»);
0 candidatos vencidos, varios candidatos, dos requests sin-id del mismo importe o un conocido no consultable quedan en
`log.error` para revisión humana, nunca como fallo. Reglas completas (ruling de Fable) en `conciliacion.md`.