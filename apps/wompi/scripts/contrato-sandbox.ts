/**
 * Prueba de contrato contra el sandbox de Wompi (B-1100). Ver «Prueba de contrato contra el sandbox» en
 * docs/conciliacion.md. Uso: `pnpm contrato:sandbox` (lee .env). Salida: UNA línea TSV
 * `<estado>\t<causas|->\t<fecha ISO>\t<detalle>`; exit 0 verde, 1 rojo, 2 sin_medida.
 * Crea una transacción de sandbox de importe pequeño y dos reembolsos parciales (B-1100), y otra transacción para
 * vigilar la búsqueda por referencia y el 422 de referencia repetida (B-1121). Nunca imprime llaves ni headers.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  combinarResultados,
  evaluarContrato,
  evaluarReferencia,
  motivoLlavesNoSandbox,
  type BusquedaObservada,
  type ObservacionContrato,
  type ObservacionReferencia,
  type RefundObservado,
  type ResultadoContrato,
} from '../src/lib/contrato-sandbox.js'
import { WompiClient } from '../src/lib/wompi-client.js'
import { WompiHttpError } from '../src/lib/wompi-error.js'

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

async function aceptacionWompi(publica: string): Promise<string> {
  const mer = await llamar('GET', `/merchants/${publica}`, publica)
  const aceptacion = (dato(mer.json)?.presigned_acceptance as { acceptance_token?: string } | undefined)?.acceptance_token
  if (!aceptacion) throw new SinMedida('sin_acceptance_token')
  return aceptacion
}

async function tokenTarjeta(publica: string): Promise<string> {
  const tok = await llamar('POST', '/tokens/cards', publica, {
    number: '4242424242424242', cvc: '123', exp_month: '12', exp_year: '30', card_holder: 'Contrato B1100',
  })
  const tokenId = dato(tok.json)?.id
  if (typeof tokenId !== 'string') throw new SinMedida(`sin_token_tarjeta(http ${tok.status})`)
  return tokenId
}

async function observar(privada: string, publica: string, integridad: string): Promise<ObservacionContrato> {
  const aceptacion = await aceptacionWompi(publica)
  const tokenId = await tokenTarjeta(publica)

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

const ESPERA_INDEXADO_MS = 2_000
const INTENTOS_INDEXADO = 5

/** Búsqueda por referencia con el cliente REAL (código de producción) y, aparte, la respuesta cruda sin refiltrar. */
async function buscar(cliente: WompiClient, privada: string, referencia: string): Promise<BusquedaObservada> {
  const cruda = await llamar('GET', `/transactions?${new URLSearchParams({ reference: referencia })}`, privada)
  const filas = Array.isArray((cruda.json as { data?: unknown } | null)?.data) ? ((cruda.json as { data: unknown[] }).data) : []
  const ajenas = filas.filter((f) => (f as { reference?: unknown } | null)?.reference !== referencia).length
  const cliente_ = await cliente.findTransactionsByReference(referencia)
  return {
    cliente: cliente_.map((t) => ({ id: t.id, reference: t.reference })),
    crudasTotal: filas.length,
    crudasAjenas: ajenas,
  }
}

async function observarReferencia(privada: string, publica: string, integridad: string): Promise<ObservacionReferencia> {
  const cliente = new WompiClient({ publicKey: publica, privateKey: privada, integrityKey: integridad, sandboxMode: true })
  const aceptacion = await aceptacionWompi(publica)
  const referencia = `b1121-${randomUUID().slice(0, 8)}`
  const crear = async () =>
    cliente.createTransaction({
      amountInCents: MONTO_TX_CENTS, currency: 'COP', customerEmail: 'contrato@example.com', reference: referencia,
      redirectUrl: 'https://example.com/contrato', acceptanceToken: aceptacion,
      paymentMethod: { type: 'CARD', token: await tokenTarjeta(publica), installments: 1 },
    })

  let txId: string
  try {
    txId = (await crear()).id
  } catch (e) {
    throw new SinMedida(`referencia_tx_no_creada(${e instanceof Error ? e.message.slice(0, 12) : 'error'})`)
  }

  // (5) Repetir la misma referencia: debe ser rechazada con la forma que reconoce esReferenciaDuplicada.
  let repeticion: ObservacionReferencia['repeticion']
  try {
    await crear()
    repeticion = { creada: true }
  } catch (e) {
    if (e instanceof SinMedida) throw e
    if (!(e instanceof WompiHttpError)) throw new SinMedida(`red:repeticion:${e instanceof Error ? e.name : 'error'}`)
    repeticion = { creada: false, error: e }
  }

  // (4) Esperar a que la búsqueda indexe la propia (reintentos) y comprobar también una referencia inexistente.
  let busquedaPropia = await buscar(cliente, privada, referencia)
  for (let i = 1; i < INTENTOS_INDEXADO && busquedaPropia.cliente.length === 0; i++) {
    await sleep(ESPERA_INDEXADO_MS)
    busquedaPropia = await buscar(cliente, privada, referencia)
  }
  const busquedaInexistente = await buscar(cliente, privada, `b1121-no-existe-${randomUUID()}`)
  return { referencia, txId, repeticion, busquedaPropia, busquedaInexistente }
}

async function medir(observador: () => Promise<ResultadoContrato>): Promise<ResultadoContrato> {
  try {
    return await observador()
  } catch (e) {
    const motivo = e instanceof SinMedida ? e.message : `error:${e instanceof Error ? e.name : 'desconocido'}`
    return { estado: 'sin_medida', causas: [motivo] }
  }
}

async function main(): Promise<ResultadoContrato> {
  const { WOMPI_PRIVATE_KEY: privada, WOMPI_PUBLIC_KEY: publica, WOMPI_INTEGRITY_KEY: integridad } = process.env
  const motivo = motivoLlavesNoSandbox(privada, publica) ?? (integridad ? null : 'llaves_ausentes')
  if (motivo) return evaluarContrato({ noMedible: motivo })
  // Las dos pruebas son independientes: que una no se mida no oculta un rojo de la otra.
  return combinarResultados([
    await medir(async () => evaluarContrato(await observar(privada!, publica!, integridad!))),
    await medir(async () => evaluarReferencia(await observarReferencia(privada!, publica!, integridad!))),
  ])
}

const resultado = await main()
const detalle = resultado.estado === 'verde' ? 'refunds[] embebido coincide con GET /refunds/{id}; listados 404; ?reference= filtra; 422 de referencia repetida reconocido' : 'ver causas'
console.log([resultado.estado, resultado.causas.join(',') || '-', new Date().toISOString(), detalle].join('\t'))
process.exit(EXIT[resultado.estado])
