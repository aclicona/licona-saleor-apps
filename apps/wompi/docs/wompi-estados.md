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
quitar la entrada de `EXCEPCIONES`):

| Handler | Reporte | Violación |
|---|---|---|
| `transaction-initialize` | B-1060 | `createTransaction` lanza → `CHARGE_FAILURE` sin `pspReference` y con `error.message` |
| `transaction-refund` | B-1071 | catch → `REFUND_FAILURE` con `String(error)` en `message`; también si el reembolso ya existe en Wompi (falla `getRefund`) |
| `transaction-cancel` | B-1072 | catch → `CANCEL_FAILURE` con `String(error)` en `message` ante un fallo de red al anular |

Cumplen: `transaction-process` (B-1057) y `transaction-charge` (no llama a Wompi). `payment-gateway-initialize` no
es `transaction-*` y solo lee la llave pública, sin red.
