/**
 * Detector de deriva entre el manifiesto vivo de la App y lo que Saleor tiene
 * registrado (B-406).
 *
 * Saleor congela la `query` de suscripción en el momento de instalar la App:
 * cambiar el código no surte efecto hasta reinstalar. En un producto
 * single-tenant replicable, publicar una versión nueva a N clientes deja las
 * suscripciones de cada uno en las del día de su instalación, sin señal. Esto
 * SOLO detecta y describe la diferencia; no repara (reinstalar toca datos de
 * cliente). Todo lo externo (fetch) se inyecta para probarlo sin Saleor real.
 */

export interface WebhookEsperado {
  name: string
  targetUrl: string
  query: string
  syncEvents?: string[]
  asyncEvents?: string[]
  isActive?: boolean
}

export interface WebhookRegistrado {
  name: string
  targetUrl: string
  isActive: boolean
  subscriptionQuery: string | null
  syncEvents: string[]
  asyncEvents: string[]
}

export interface Deriva {
  webhook: string
  tipo: 'AUSENTE_EN_SALEOR' | 'QUERY_DISTINTA' | 'EVENTOS_DISTINTOS' | 'INACTIVO' | 'SOBRANTE_EN_SALEOR'
  detalle: string
}

const normalizar = (q: string | null | undefined) => (q ?? '').replace(/\s+/g, ' ').trim()
const ordenados = (xs: string[] | undefined) => [...(xs ?? [])].sort().join(',')

export function detectarDeriva(esperados: WebhookEsperado[], registrados: WebhookRegistrado[]): Deriva[] {
  const deriva: Deriva[] = []
  const porUrl = new Map(registrados.map((r) => [r.targetUrl, r]))

  for (const e of esperados) {
    const r = porUrl.get(e.targetUrl)
    if (!r) {
      deriva.push({ webhook: e.name, tipo: 'AUSENTE_EN_SALEOR', detalle: `Saleor no tiene registrado ${e.targetUrl}` })
      continue
    }
    if (normalizar(e.query) !== normalizar(r.subscriptionQuery)) {
      deriva.push({
        webhook: e.name,
        tipo: 'QUERY_DISTINTA',
        detalle: 'la query registrada en Saleor difiere de la del manifiesto actual — hay que reinstalar la App',
      })
    }
    if (ordenados(e.syncEvents) !== ordenados(r.syncEvents) || ordenados(e.asyncEvents) !== ordenados(r.asyncEvents)) {
      deriva.push({
        webhook: e.name,
        tipo: 'EVENTOS_DISTINTOS',
        detalle: `esperado sync=[${ordenados(e.syncEvents)}] async=[${ordenados(e.asyncEvents)}], registrado sync=[${ordenados(r.syncEvents)}] async=[${ordenados(r.asyncEvents)}]`,
      })
    }
    if ((e.isActive ?? true) && !r.isActive) {
      deriva.push({ webhook: e.name, tipo: 'INACTIVO', detalle: 'el webhook está desactivado en Saleor' })
    }
  }

  const urlsEsperadas = new Set(esperados.map((e) => e.targetUrl))
  for (const r of registrados) {
    if (!urlsEsperadas.has(r.targetUrl)) {
      deriva.push({ webhook: r.name, tipo: 'SOBRANTE_EN_SALEOR', detalle: `Saleor tiene ${r.targetUrl}, que el manifiesto ya no declara` })
    }
  }

  return deriva
}

export interface OpcionesConsulta {
  saleorApiUrl: string
  appToken: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

const QUERY_WEBHOOKS = `{ app { webhooks { name targetUrl isActive subscriptionQuery syncEvents { eventType } asyncEvents { eventType } } } }`

/** Lee los webhooks de la App autenticada. Lanza si Saleor no responde o responde con errores. */
export async function consultarWebhooksRegistrados(opciones: OpcionesConsulta): Promise<WebhookRegistrado[]> {
  const { saleorApiUrl, appToken, fetchFn = fetch, timeoutMs = 5000 } = opciones
  const base = saleorApiUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '')

  const res = await fetchFn(`${base}/graphql/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${appToken}` },
    body: JSON.stringify({ query: QUERY_WEBHOOKS }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Saleor respondió HTTP ${res.status}`)

  const cuerpo = (await res.json()) as {
    data?: { app?: { webhooks?: Array<Omit<WebhookRegistrado, 'syncEvents' | 'asyncEvents'> & {
      syncEvents: Array<{ eventType: string }>
      asyncEvents: Array<{ eventType: string }>
    }> } | null }
    errors?: Array<{ message: string }>
  }
  if (cuerpo.errors?.length) throw new Error(`Saleor devolvió errores: ${cuerpo.errors.map((e) => e.message).join('; ')}`)
  const webhooks = cuerpo.data?.app?.webhooks
  if (!webhooks) throw new Error('Saleor no devolvió la App autenticada (¿token inválido?)')

  return webhooks.map((w) => ({
    name: w.name,
    targetUrl: w.targetUrl,
    isActive: w.isActive,
    subscriptionQuery: w.subscriptionQuery,
    syncEvents: w.syncEvents.map((e) => e.eventType),
    asyncEvents: w.asyncEvents.map((e) => e.eventType),
  }))
}

interface LogMinimo {
  error(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  info(obj: object, msg: string): void
}

/**
 * Compara el manifiesto vivo con lo registrado en Saleor y lo escribe en el log.
 * NUNCA lanza: es una señal de diagnóstico, no puede tumbar el arranque. Sin token
 * (App aún sin instalar) no hay nada que comparar y no es deriva.
 */
export async function avisarDerivaAlArranque(opciones: {
  webhooksManifiesto: WebhookEsperado[]
  saleorApiUrl: string
  appToken: string
  log: LogMinimo
  fetchFn?: typeof fetch
}): Promise<Deriva[] | null> {
  const { webhooksManifiesto, saleorApiUrl, appToken, log, fetchFn } = opciones
  if (!appToken || !saleorApiUrl) return null
  try {
    const registrados = await consultarWebhooksRegistrados({ saleorApiUrl, appToken, fetchFn })
    const deriva = detectarDeriva(webhooksManifiesto, registrados)
    if (deriva.length > 0) {
      log.error(
        { deriva },
        'DERIVA entre el manifiesto de la App y lo que Saleor tiene instalado: Saleor congela las suscripciones ' +
          'al instalar, así que el código nuevo no surte efecto hasta reinstalar la App',
      )
    } else {
      log.info({ webhooks: registrados.length }, 'Sin deriva: el manifiesto coincide con lo instalado en Saleor')
    }
    return deriva
  } catch (error) {
    log.warn({ error }, 'No se pudo comprobar la deriva del manifiesto contra Saleor (se omite)')
    return null
  }
}
