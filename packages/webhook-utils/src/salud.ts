/**
 * Healthcheck de cadena: ¿la App puede hacer su trabajo de verdad, o solo está viva?
 *
 * Un `/health` que dice "el proceso responde" se pone verde sobre una App sin
 * configuración, con Saleor inalcanzable o sin JWKS, y las tres se ven idénticas
 * desde fuera hasta que un comprador no puede pagar. Esto verifica cada eslabón
 * por separado para que el diagnóstico diga CUÁL falló.
 *
 * Todo lo externo (fetch, lista de variables faltantes) se inyecta: se prueba con
 * dobles, sin Saleor real. Nunca devuelve valores de variables, solo sus nombres.
 */

export interface EstadoEslabon {
  ok: boolean
  detalle?: string
}

export interface ResultadoCadena {
  ok: boolean
  checks: {
    config: EstadoEslabon
    saleor: EstadoEslabon
    jwks: EstadoEslabon
  }
}

export interface OpcionesCadena {
  /** `SALEOR_API_URL` tal cual (con o sin `/graphql/`). Vacío = no configurada. */
  saleorApiUrl: string
  /** Nombres de variables obligatorias/de operación ausentes (ya calculado por la App). */
  variablesFaltantes: string[]
  fetchFn?: typeof fetch
  timeoutMs?: number
}

const TIMEOUT_POR_DEFECTO_MS = 3000

function mensaje(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function comprobar(fn: () => Promise<EstadoEslabon>): Promise<EstadoEslabon> {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, detalle: mensaje(err) }
  }
}

export async function verificarCadena(opciones: OpcionesCadena): Promise<ResultadoCadena> {
  const { saleorApiUrl, variablesFaltantes, fetchFn = fetch, timeoutMs = TIMEOUT_POR_DEFECTO_MS } = opciones

  const config: EstadoEslabon =
    variablesFaltantes.length === 0
      ? { ok: true }
      : { ok: false, detalle: `faltan: ${variablesFaltantes.join(', ')}` }

  let saleor: EstadoEslabon
  let jwks: EstadoEslabon

  if (!saleorApiUrl.trim()) {
    const sinUrl = { ok: false, detalle: 'SALEOR_API_URL no configurada' }
    saleor = sinUrl
    jwks = sinUrl
  } else {
    const base = saleorApiUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '')

    // En paralelo: el tiempo total queda acotado por un solo timeout.
    ;[saleor, jwks] = await Promise.all([
      comprobar(async () => {
        const res = await fetchFn(`${base}/graphql/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ __typename }' }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        return res.ok ? { ok: true } : { ok: false, detalle: `HTTP ${res.status}` }
      }),
      comprobar(async () => {
        const res = await fetchFn(`${base}/.well-known/jwks.json`, {
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) return { ok: false, detalle: `HTTP ${res.status}` }
        const cuerpo = (await res.json()) as { keys?: unknown }
        if (!Array.isArray(cuerpo.keys) || cuerpo.keys.length === 0) {
          return { ok: false, detalle: 'JWKS sin claves' }
        }
        return { ok: true }
      }),
    ])
  }

  return { ok: config.ok && saleor.ok && jwks.ok, checks: { config, saleor, jwks } }
}
