/**
 * Plazo global de los handlers síncronos ante Saleor (B-1078). Saleor espera la respuesta del webhook
 * 18 s (WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT) y pasado eso registra el fallo ("Failed to delivery
 * request."), aunque la operación ya exista en Wompi. Cada llamada a Wompi tiene su propio timeout de
 * 15 s, que encadenadas suman más de 18 s; este plazo acota la SUMA y deja ~3 s de margen para responder.
 */
export const PLAZO_GLOBAL_MS = 15_000
