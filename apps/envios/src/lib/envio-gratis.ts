import type { MetodoEnvio } from './tarifas.js'

export const ENVIO_GRATIS_ID = 'envio-gratis-temporal'

/**
 * Salvaguarda: una caducidad a más de 72 h se ignora. Evita dejar el envío gratis encendido por
 * error (p. ej. un año mal escrito). Las compras de prueba caben de sobra en esta ventana.
 */
export const HORIZONTE_MAXIMO_MS = 72 * 60 * 60 * 1000

export interface EnvioGratisEstado {
  vigente: boolean
  /** Caducidad interpretada; solo cuando `vigente` es true. */
  hasta?: Date
  /** Por qué no se ofrece; ausente en el caso normal (variable sin definir). */
  motivo?: string
}

// ISO 8601 con hora y zona obligatoria (Z o ±hh:mm): sin zona, `Date` usaría la del servidor.
const ISO_CON_ZONA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Decide si el envío gratis temporal se ofrece, dado el valor de `ENVIO_GRATIS_HASTA`. Pura. */
export function envioGratisVigente(valor: string | undefined, ahora: Date): EnvioGratisEstado {
  const texto = valor?.trim()
  if (!texto) return { vigente: false }

  if (!ISO_CON_ZONA.test(texto)) {
    const tieneHora = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(texto)
    return {
      vigente: false,
      motivo: tieneHora
        ? 'ENVIO_GRATIS_HASTA sin zona horaria (use p. ej. -05:00 o Z)'
        : 'ENVIO_GRATIS_HASTA inválida: se espera ISO 8601 con zona, p. ej. 2026-11-27T06:00:00-05:00',
    }
  }
  const hasta = new Date(texto)
  if (Number.isNaN(hasta.getTime())) {
    return { vigente: false, motivo: 'ENVIO_GRATIS_HASTA inválida: fecha inexistente' }
  }
  if (ahora.getTime() >= hasta.getTime()) {
    return { vigente: false, motivo: `ENVIO_GRATIS_HASTA vencida (${hasta.toISOString()})` }
  }
  if (hasta.getTime() - ahora.getTime() > HORIZONTE_MAXIMO_MS) {
    return {
      vigente: false,
      motivo: `ENVIO_GRATIS_HASTA ignorada: está a más de 72 h en el futuro (${hasta.toISOString()})`,
    }
  }
  return { vigente: true, hasta }
}

/** Devuelve una lista nueva con el método gratis primero; no muta `metodos`. */
export function conEnvioGratis(metodos: readonly MetodoEnvio[]): MetodoEnvio[] {
  return [
    {
      id: ENVIO_GRATIS_ID,
      name: 'Envío gratis (temporal)',
      amount: 0,
      currency: 'COP',
      minimumDeliveryDays: 3,
      maximumDeliveryDays: 5,
    },
    ...metodos,
  ]
}
