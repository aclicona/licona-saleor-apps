/**
 * Prueba de contrato contra el sandbox de Wompi (B-1100). Ver «Prueba de contrato contra el sandbox» en
 * docs/conciliacion.md. Uso: `pnpm contrato:sandbox` (lee .env). Salida: UNA línea TSV
 * `<estado>\t<causas|->\t<fecha ISO>\t<detalle>`; exit 0 verde, 1 rojo, 2 sin_medida.
 * Crea una transacción de sandbox de importe pequeño y dos reembolsos parciales. Nunca imprime llaves ni headers.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  evaluarContrato,
  motivoLlavesNoSandbox,
  type ObservacionContrato,
  type RefundObservado,
  type ResultadoContrato,
} from '../src/lib/contrato-sandbox.js'

const BASE_SANDBOX = 'https://sandbox.wompi.co/v1' // fija: nunca producción
const TIMEOUT_MS = 15_000
const MONTO_TX_CENTS = 5_000_000 // 50.000 COP
const MONTO_REEMBOLSO_CENTS = 1_000_000
const POLL_INTENTOS = 10
const POLL_ESPERA_MS = 2_000
const ESPERA_REFUNDS_MS = 5_000

const EXIT: Record<ResultadoContrato['estado'], number> = { verde: 0, rojo: 1, sin_medida: 2 }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class SinMedida extends Error {}

async function llamar(metodo: string, ruta: string, llave: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  let res: Response
  try {
    res = await fetch(BASE_SANDBOX + ruta, {
      method: metodo,
      headers: { Authorization: `Bearer ${llave}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new SinMedida(`red:${metodo} ${ruta.split('?')[0]}:${e instanceof Error ? e.name : 'error'}`)
  }
  if (res.status === 401) throw new SinMedida('http_401')
  const texto = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(texto)
  } catch {
    /* cuerpo vacío o no JSON (p. ej. los 404 de los listados): válido, json queda null */
  }
  return { status: res.status, json }
}

const dato = (j: unknown): Record<string, unknown> | undefined => (j as { data?: Record<string, unknown> } | null)?.data

async function observar(privada: string, publica: string, integridad: string): Promise<ObservacionContrato> {
  const mer = await llamar('GET', `/merchants/${publica}`, publica)
  const aceptacion = (dato(mer.json)?.presigned_acceptance as { acceptance_token?: string } | undefined)?.acceptance_token
  if (!aceptacion) throw new SinMedida('sin_acceptance_token')

  const tok = await llamar('POST', '/tokens/cards', publica, {
    number: '4242424242424242', cvc: '123', exp_month: '12', exp_year: '30', card_holder: 'Contrato B1100',
  })
  const tokenId = dato(tok.json)?.id
  if (typeof tokenId !== 'string') throw new SinMedida(`sin_token_tarjeta(http ${tok.status})`)

  const referencia = `b1100-${randomUUID().slice(0, 8)}`
  const firma = createHash('sha256').update(`${referencia}${MONTO_TX_CENTS}COP${integridad}`).digest('hex')
  const tx = await llamar('POST', '/transactions', privada, {
    amount_in_cents: MONTO_TX_CENTS, currency: 'COP', customer_email: 'contrato@example.com', reference: referencia,
    acceptance_token: aceptacion, signature: firma, payment_method: { type: 'CARD', token: tokenId, installments: 1 },
  })
  const txId = dato(tx.json)?.id
  if (typeof txId !== 'string') throw new SinMedida(`tx_no_creada(http ${tx.status})`)

  let estado = ''
  for (let i = 0; i < POLL_INTENTOS; i++) {
    await sleep(POLL_ESPERA_MS)
    estado = String(dato((await llamar('GET', `/transactions/${txId}`, privada)).json)?.status)
    if (estado !== 'PENDING') break
  }
  if (estado !== 'APPROVED') throw new SinMedida(`tx_no_aprobada(${estado})`)

  const ids: unknown[] = []
  for (let i = 0; i < 2; i++) {
    const r = await llamar('POST', '/refunds', privada, { transaction_id: txId, amount_in_cents: MONTO_REEMBOLSO_CENTS })
    ids.push(dato(r.json)?.id)
    if (i === 0) await sleep(POLL_ESPERA_MS) // created_at distintos entre sí
  }
  if (ids.some((id) => id === undefined)) throw new SinMedida('refund_no_creado')
  await sleep(ESPERA_REFUNDS_MS)

  const txFinal = await llamar('GET', `/transactions/${txId}`, privada)
  const refunds: RefundObservado[] = []
  for (const id of ids) {
    const g = await llamar('GET', `/refunds/${String(id)}`, privada)
    refunds.push({ httpStatus: g.status, data: g.json })
  }
  const rutas = [`/refunds?transaction_id=${txId}`, `/transactions/${txId}/refunds`]
  const listados = []
  for (const ruta of rutas) {
    listados.push({ ruta: ruta.replace(txId, '{id}'), httpStatus: (await llamar('GET', ruta, privada)).status })
  }
  return { refundsEmbebidos: dato(txFinal.json)?.refunds, refunds, listados }
}

async function main(): Promise<ResultadoContrato> {
  const { WOMPI_PRIVATE_KEY: privada, WOMPI_PUBLIC_KEY: publica, WOMPI_INTEGRITY_KEY: integridad } = process.env
  const motivo = motivoLlavesNoSandbox(privada, publica) ?? (integridad ? null : 'llaves_ausentes')
  if (motivo) return evaluarContrato({ noMedible: motivo })
  try {
    return evaluarContrato(await observar(privada!, publica!, integridad!))
  } catch (e) {
    if (e instanceof SinMedida) return evaluarContrato({ noMedible: e.message })
    return evaluarContrato({ noMedible: `error:${e instanceof Error ? e.name : 'desconocido'}` })
  }
}

const resultado = await main()
const detalle = resultado.estado === 'verde' ? 'refunds[] embebido coincide con GET /refunds/{id}; listados 404' : 'ver causas'
console.log([resultado.estado, resultado.causas.join(',') || '-', new Date().toISOString(), detalle].join('\t'))
process.exit(EXIT[resultado.estado])
