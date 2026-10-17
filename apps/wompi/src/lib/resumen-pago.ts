/**
 * Resumen de un evento de Wompi apto para logs (B-1374).
 *
 * Decisión de Andrés: en los avisos del módulo de pagos se registra únicamente
 * referencia, estado, importe y fecha del pago, SIN correo ni nombre del cliente.
 * El cuerpo crudo trae PII (email, customer_data, envío, medio de pago) y el
 * `redact` de pino censura por nombre de campo, no dentro de un string, así que
 * la única defensa es no volcar el cuerpo. Esto es una LISTA BLANCA: un campo
 * nuevo de Wompi no llega al log a menos que se añada aquí a propósito.
 */
export interface ResumenPago {
  evento: string | null
  referencia: string | null
  estado: string | null
  amountInCents: number | null
  currency: string | null
  fecha: string | null
}

const comoObjeto = (valor: unknown): Record<string, unknown> | null =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null

const comoTexto = (valor: unknown): string | null => (typeof valor === 'string' ? valor : null)

const comoNumero = (valor: unknown): number | null =>
  typeof valor === 'number' && Number.isFinite(valor) ? valor : null

export function resumenPago(evento: unknown): ResumenPago {
  const raiz = comoObjeto(evento)
  const txn = comoObjeto(comoObjeto(raiz?.data)?.transaction)
  return {
    evento: comoTexto(raiz?.event),
    referencia: comoTexto(txn?.reference),
    estado: comoTexto(txn?.status),
    amountInCents: comoNumero(txn?.amount_in_cents),
    currency: comoTexto(txn?.currency),
    fecha: comoTexto(txn?.created_at),
  }
}
