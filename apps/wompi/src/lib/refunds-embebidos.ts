/**
 * `refunds[]` embebido en `GET /transactions/{id}` (B-1097). Dato externo: se valida la forma y un item mal
 * formado simplemente no cuenta. Verificado en sandbox (2026-10-09): cada item trae
 * `created_at, transaction_id, status, amount_in_cents, status_message` y NO trae `id`.
 */
export interface RefundEmbebido {
  /** `created_at` como epoch ms (nunca se compara como string). */
  creadoMs: number
  amountInCents: number
  status: string
}

export function refundsEmbebidos(txn: { refunds?: unknown }): RefundEmbebido[] {
  if (!Array.isArray(txn.refunds)) return []
  const validos: RefundEmbebido[] = []
  for (const bruto of txn.refunds as unknown[]) {
    if (typeof bruto !== 'object' || bruto === null) continue
    const { created_at: creado, amount_in_cents: cents, status } = bruto as Record<string, unknown>
    if (typeof creado !== 'string' || typeof status !== 'string') continue
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) continue
    const creadoMs = Date.parse(creado)
    if (!Number.isFinite(creadoMs)) continue
    validos.push({ creadoMs, amountInCents: cents, status })
  }
  return validos
}
