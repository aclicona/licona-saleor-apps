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
