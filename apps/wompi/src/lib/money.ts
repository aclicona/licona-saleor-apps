/**
 * Conversión de importes de dinero entre Saleor y Wompi.
 *
 * Contexto: Saleor entrega los importes en COP con hasta 3 decimales
 * (`DEFAULT_DECIMAL_PLACES = 3`, valor global de Saleor, no configurable
 * por moneda — ver ../../CLAUDE.md raíz del proyecto). En la práctica el
 * peso colombiano no usa decimales, pero eso NO garantiza que el número
 * que llega sea un entero limpio: puede traer residuo de punto flotante
 * (p. ej. `120000.004`) heredado de ese almacenamiento interno.
 *
 * Wompi, en cambio, exige `amount_in_cents` como un entero exacto.
 *
 * Multiplicar por 100 "a pelo" (`amount * 100`) es inseguro para dinero:
 * en aritmética IEEE-754, `19.99 * 100` da `1998.9999999999998`, no `1999`.
 * Si ese valor se envía tal cual a Wompi (o se trunca en vez de redondear),
 * el cliente paga un centavo menos de lo que debería — dinero real mal
 * cobrado. Por eso esta función redondea explícitamente al centavo más
 * cercano en vez de confiar en que la multiplicación dé un entero.
 */

/**
 * Convierte un importe en pesos colombianos (COP), tal como lo entrega
 * Saleor, a centavos, tal como los espera la API de Wompi.
 *
 * Invariante que protege: el resultado SIEMPRE es un entero no negativo,
 * o la función lanza — nunca devuelve `NaN`, `Infinity` ni un decimal
 * silencioso que termine convertido en un cobro incorrecto.
 *
 * Decisión sobre entradas inválidas (NaN, Infinity, negativos, no-numéricas):
 * se LANZA un error en vez de devolver 0 o `NaN`. La razón es que este valor
 * viaja directo a una pasarela de pago real: dejar pasar un importe corrupto
 * en silencio puede terminar en un cobro de $0, un cobro por `NaN` centavos
 * (rechazado tarde, en el peor caso con datos inconsistentes) o un crash
 * más adelante sin contexto. Lanzar aquí, cerca del origen del dato, hace
 * que el error sea explícito y que los handlers de webhook (que ya envuelven
 * esta llamada en try/catch) respondan `CHARGE_FAILURE` / `REFUND_FAILURE`
 * en vez de intentar cobrar algo indefinido.
 *
 * Decisión sobre decimales residuales (p. ej. `120000.004`): se redondean
 * al centavo de Wompi más cercano con `Math.round`. Como COP no tiene
 * decimales en la práctica, cualquier residuo es ruido de punto flotante
 * del almacenamiento de 3 decimales de Saleor, no un importe real distinto;
 * absorberlo en el redondeo es más seguro que lanzar por un ruido de
 * fracciones de centavo.
 *
 * @param amountCop Importe en pesos colombianos, como lo envía Saleor en `action.amount`.
 * @returns El importe equivalente en centavos, como entero, listo para `amount_in_cents` de Wompi.
 * @throws {Error} Si `amountCop` no es un número finito o es negativo.
 */
export function copToCents(amountCop: number): number {
  if (typeof amountCop !== 'number' || Number.isNaN(amountCop)) {
    throw new Error(`Importe COP inválido (no es un número): ${String(amountCop)}`)
  }
  if (!Number.isFinite(amountCop)) {
    throw new Error(`Importe COP inválido (no es finito): ${amountCop}`)
  }
  if (amountCop < 0) {
    throw new Error(`Importe COP inválido (negativo): ${amountCop}`)
  }

  // Math.round corrige el error de punto flotante de `amountCop * 100`
  // (ej: 19.99 * 100 === 1998.9999999999998) y absorbe el residuo de
  // decimales que puede llegar por el almacenamiento de 3 decimales de Saleor.
  return Math.round(amountCop * 100)
}

/**
 * Convierte un importe en centavos, tal como lo entrega Wompi en el campo
 * `amount_in_cents` de sus webhooks, a pesos colombianos, tal como los espera
 * Saleor en `transactionEventReport(amount:)`.
 *
 * Es la conversión inversa de `copToCents` y existe para que el handler del
 * webhook entrante no haga `txn.amount_in_cents / 100` inline: ese importe es
 * el que Saleor va a comparar contra el evento previo para decidir si el
 * reintento es idéntico (misma `pspReference` + mismo `type` + mismo importe
 * → `alreadyProcessed`; importe distinto → `INCORRECT_DETAILS`). Un importe
 * mal convertido no solo reporta mal el cobro: rompe la deduplicación del
 * lado servidor.
 *
 * Decisión sobre entradas inválidas: se LANZA. Wompi documenta
 * `amount_in_cents` como un entero; un valor no entero, no finito, negativo o
 * fuera del rango entero seguro de IEEE-754 no es un importe real sino un
 * payload corrupto o manipulado. Lanzar aquí permite que el handler lo trate
 * como lo que es — un fallo PERMANENTE que ningún reintento de Wompi va a
 * arreglar — y responda 200 con log crítico en vez de reportar a Saleor un
 * importe inventado.
 *
 * Sobre la precisión: dividir un entero de centavos entre 100 es seguro en
 * IEEE-754 aunque el resultado no sea representable exacto (19.99 no lo es).
 * `1999 / 100` da el double más cercano a 19.99 y `.toString()` devuelve
 * `"19.99"` — la representación más corta que round-trippea. Por eso no hace
 * falta redondear el resultado: es la división cruda la que da el valor
 * correcto, al revés que en `copToCents`, donde la multiplicación cruda falla.
 *
 * @param amountInCents Importe en centavos, como lo envía Wompi en `data.transaction.amount_in_cents`.
 * @returns El importe equivalente en pesos colombianos, listo para el campo `amount` de Saleor.
 * @throws {Error} Si `amountInCents` no es un entero seguro y no negativo.
 */
export function centsToCop(amountInCents: number): number {
  if (typeof amountInCents !== 'number' || Number.isNaN(amountInCents)) {
    throw new Error(`Importe en centavos inválido (no es un número): ${String(amountInCents)}`)
  }
  if (!Number.isFinite(amountInCents)) {
    throw new Error(`Importe en centavos inválido (no es finito): ${amountInCents}`)
  }
  if (amountInCents < 0) {
    throw new Error(`Importe en centavos inválido (negativo): ${amountInCents}`)
  }
  // Number.isSafeInteger rechaza a la vez los no enteros (1999.5) y las
  // magnitudes fuera del rango donde los enteros de JS son exactos.
  if (!Number.isSafeInteger(amountInCents)) {
    throw new Error(`Importe en centavos inválido (no es un entero seguro): ${amountInCents}`)
  }

  return amountInCents / 100
}
