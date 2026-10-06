/**
 * Acciones de transacción que Saleor habilita en el Dashboard (B-432).
 *
 * Saleor solo habilita REFUND / CANCEL / CHARGE sobre una `TransactionItem` si
 * la App las declara: en las respuestas síncronas (`actions`, en minúsculas
 * las normaliza Saleor) y en `transactionEventReport` (`availableActions`).
 * Sin declararlas el botón "Refund" del Dashboard queda deshabilitado aunque
 * el cobro esté aprobado.
 *
 * Reembolso parcial: tras `REFUND_SUCCESS` se sigue declarando REFUND. Saleor
 * limita el importe al saldo cobrado; quitarlo bloquearía reembolsos
 * sucesivos, y conocer el saldo aquí exigiría estado que la App no tiene.
 */

export type AccionTransaccion = 'CHARGE' | 'REFUND' | 'CANCEL'

/** Para la respuesta síncrona de INITIALIZE / PROCESS_SESSION. */
export function accionesParaResultado(result: string): AccionTransaccion[] {
  switch (result) {
    case 'CHARGE_SUCCESS':
      return ['REFUND']
    case 'AUTHORIZATION_SUCCESS':
      return ['CHARGE', 'CANCEL']
    default:
      return []
  }
}

/** Para `availableActions` de `transactionEventReport`, según el tipo reportado. */
export function accionesParaEvento(tipo: string): AccionTransaccion[] {
  switch (tipo) {
    case 'CHARGE_SUCCESS':
    case 'REFUND_SUCCESS': // parcial: Saleor limita el importe al saldo
    case 'REFUND_FAILURE': // el cobro sigue en pie
      return ['REFUND']
    default:
      return [] // CHARGE_FAILURE, CANCEL_*: nada que hacer sobre la transacción
  }
}
