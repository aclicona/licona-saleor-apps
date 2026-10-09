/**
 * Plazo global de los webhooks síncronos ante Saleor (B-1078, B-1080).
 *
 * Saleor espera la respuesta de un webhook síncrono `WEBHOOK_WAITING_FOR_RESPONSE_TIMEOUT` = 18 s (fork
 * de Saleor) y, pasado eso, registra el fallo ("Failed to delivery request.") aunque la operación ya
 * exista en el PSP. Cada llamada externa tiene su propio timeout, y encadenadas (o sumadas a la descarga
 * del JWKS al verificar la firma, hasta 5 s) superan los 18 s. Este plazo acota la SUMA y deja ~3 s de
 * margen para responder.
 *
 * Uso en un handler síncrono: `const plazo = crearPlazo()` en la PRIMERA línea (el reloj cuenta desde la
 * llegada de la petición), pasar `plazo.signal` a cada llamada externa y `plazo.limpiar()` en un `finally`.
 * `contrato-plazo.test.ts` (en cada app) falla si un handler síncrono no lo respeta.
 *
 * Sobre el supuesto de «hasta 5 s» de la firma (B-1105): lo pone `jose` por defecto (`timeoutDuration`
 * de `createRemoteJWKSet`, hasta el primer byte), y `jwks-timeout.test.ts` lo ata a la realidad. Aun así
 * el contrato no depende de él: como el plazo arranca ANTES de verificar y las llamadas posteriores solo
 * disponen de lo que queda, una firma lenta (12 s en el test) no empuja la respuesta más allá de los 15 s.
 */
export const PLAZO_WEBHOOK_SINCRONO_MS = 15_000

export interface Plazo {
  /** Se aborta cuando se agota el plazo. Se crea al primer acceso, con el tiempo que quede entonces. */
  readonly signal: AbortSignal
  /** Milisegundos que quedan (negativo si ya se agotó), contados desde `crearPlazo`. */
  restanteMs(): number
  /** Cancela el temporizador. Idempotente; llamarlo en un `finally`. */
  limpiar(): void
}

/**
 * Crea un plazo que empieza a contar YA. El temporizador es perezoso: solo existe si alguien lee
 * `signal`, así los `return` tempranos (firma inválida, payload incompleto) no dejan nada vivo.
 */
export function crearPlazo(ms: number = PLAZO_WEBHOOK_SINCRONO_MS, motivo = 'Plazo global del webhook agotado'): Plazo {
  const inicio = Date.now()
  const restanteMs = () => ms - (Date.now() - inicio)
  let controlador: AbortController | undefined
  let temporizador: ReturnType<typeof setTimeout> | undefined
  return {
    get signal() {
      if (!controlador) {
        controlador = new AbortController()
        const ac = controlador
        // Ya agotado: la señal nace abortada (síncrono), sin esperar a un tick.
        if (restanteMs() <= 0) ac.abort(new Error(motivo))
        else temporizador = setTimeout(() => ac.abort(new Error(motivo)), restanteMs())
      }
      return controlador.signal
    },
    restanteMs,
    limpiar() {
      if (temporizador !== undefined) clearTimeout(temporizador)
      temporizador = undefined
    },
  }
}

/** Forma mínima de un webhook de manifiesto para descubrir los síncronos. */
export interface WebhookConEventos {
  name: string
  targetUrl: string
  syncEvents?: string[]
}

/**
 * Webhooks síncronos de un manifiesto, con la ruta de su `targetUrl`. Base del test-contrato del plazo:
 * parte del manifiesto (lo que Saleor realmente registra), no de una lista escrita a mano.
 */
export function webhooksSincronos(webhooks: WebhookConEventos[]): { name: string; ruta: string; eventos: string[] }[] {
  return webhooks
    .filter((w) => (w.syncEvents?.length ?? 0) > 0)
    .map((w) => ({ name: w.name, ruta: new URL(w.targetUrl).pathname, eventos: w.syncEvents ?? [] }))
}
