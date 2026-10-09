import { PLAZO_WEBHOOK_SINCRONO_MS } from '@licona/webhook-utils'

/**
 * Plazo global de los handlers síncronos ante Saleor (B-1078). La constante y el helper `crearPlazo`
 * viven en `@licona/webhook-utils` (B-1080) para que cualquier app los comparta; aquí queda el alias
 * con el que ya lo importan los demás módulos de Wompi.
 */
export const PLAZO_GLOBAL_MS = PLAZO_WEBHOOK_SINCRONO_MS
