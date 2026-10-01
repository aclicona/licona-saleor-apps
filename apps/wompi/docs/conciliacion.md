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
3. Disparar con `POST /api/conciliacion/ejecutar` y `Authorization: Bearer <token>`. Responde 200 con el
   resumen (`revisadas, yaReportadas, reportadas, sinMapeo, omitidas, errores`), 502 si falló el API de Wompi,
   401 sin token válido. **No hay cron cableado**: quien la encienda programa el disparo.

## Decisiones pendientes (Andrés)

| Tema | Opciones | Recomendación |
|---|---|---|
| Frecuencia | cada 5 min / 15 min / horaria | cada 15 min: acota la pérdida a minutos con coste bajo (Saleor deduplica) |
| Ventana | 1 h / 24 h / 7 d | 24 h (default), siempre ≥ 2× la frecuencia y ≥ la caída máxima tolerada de Saleor |
| Credenciales | llave privada Wompi ya existente / llave de solo lectura (si Wompi la ofrece) + token propio del endpoint | reutilizar la privada; token del endpoint distinto, rotado desde el aprovisionamiento |
| Disparador | cron externo (Railway cron/GitHub Actions) llamando al endpoint / script | cron externo con el token en su secret store |

## Pendiente de verificación humana

- **El endpoint de listado de Wompi no está verificado**: `WompiClient.listTransactions` asume
  `GET /transactions?from_date&until_date&page&page_size` con llave privada y `meta.total_pages`. Probar en el
  sandbox antes de encender; si difiere, solo cambia ese método.
- Un `VOIDED` re-reportado como `CHARGE_FAILURE` revierte el cobro en Saleor (ver `wompi-estados.md`); requiere
  Saleor vivo para confirmarlo.
