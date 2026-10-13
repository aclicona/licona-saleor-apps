/**
 * Acciones de transacción que Saleor habilita en el Dashboard (B-432).
 *
 * Saleor solo habilita REFUND / CANCEL / CHARGE sobre una `TransactionItem` si
 * la App las declara: en las respuestas síncronas (`actions`, en minúsculas
 * las normaliza Saleor) y en `transactionEventReport` (`availableActions`).
 * Sin declararlas el botón "Refund" del Dashboard queda deshabilitado aunque
 * el cobro esté aprobado.
 *
 * `CANCEL_FAILURE` declara REFUND: `availableActions` es destructivo, y con `[]`
 * un fallo de anulación (p. ej. el que cierra la conciliación, B-1089) apagaba
 * Refund aunque Wompi siga en APPROVED. Es seguro para todos los caminos: la App
 * solo cobra (CHARGE_*), nunca autoriza sin capturar (`AUTHORIZATION_SUCCESS` no
 * lo produce ningún flujo), así que todo CANCEL_FAILURE recae sobre un cobro.
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
    case 'CANCEL_FAILURE': // la anulación no se aplicó: el cobro sigue en pie (B-1089)
      return ['REFUND']
    default:
      return [] // CHARGE_FAILURE, CANCEL_SUCCESS: nada que hacer sobre la transacción
  }
}
