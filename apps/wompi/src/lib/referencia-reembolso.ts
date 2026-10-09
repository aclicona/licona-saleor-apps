/**
 * Referencia provisional de un reembolso cuyo id de Wompi no se llegó a conocer (B-1071).
 *
 * `transaction-refund` responde sin `result` y con `pspReference` = `<psp de la transacción>:reembolso-sin-id:<uuid>`
 * cuando no sabe el id del reembolso. La conciliación (B-1077) reconoce ese formato para no consultar a Wompi
 * con un id inexistente.
 */
export const SEPARADOR_REEMBOLSO_SIN_ID = ':reembolso-sin-id:'

export function esReferenciaSinId(psp: string): boolean {
  return psp.includes(SEPARADOR_REEMBOLSO_SIN_ID)
}

/** Psp de la transacción de Wompi: el prefijo antes del separador (`undefined` si no es una referencia sin id). */
export function transaccionDeReferenciaSinId(psp: string): string | undefined {
  const i = psp.indexOf(SEPARADOR_REEMBOLSO_SIN_ID)
  return i > 0 ? psp.slice(0, i) : undefined
}
