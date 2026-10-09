import { accionesParaResultado } from '../lib/acciones.js'
import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifySaleorWebhook, SaleorWebhookError, crearPlazo } from '@licona/webhook-utils'
import { wompiClient, type WompiTransaction } from '../lib/wompi-client.js'
import { copToCents } from '../lib/money.js'
import { camposDeCorrelacion } from '../lib/correlacion.js'
import { referenciaParaWompi } from '../lib/referencia.js'
import { validarDatosTarjeta } from '../lib/tarjeta.js'
import { esRechazoDefinitivo, esReferenciaDuplicada } from '../lib/wompi-error.js'
import { PLAZO_GLOBAL_MS } from '../lib/plazo.js'

/** Mensajes fijos hacia Saleor (B-1060): el texto del error real va solo al log. */
const MENSAJE_SIN_TRANSACCION = 'No se pudo iniciar el pago con Wompi'
const MENSAJE_RECHAZO = 'Wompi rechazó la transacción'
const MENSAJE_DESCONOCIDO = 'Estado en Wompi desconocido por un fallo transitorio; se resolverá por conciliación'

// Mismo mapa que `transaction-process.ts` / `wompi-incoming.ts` (VOIDED -> CHARGE_FAILURE es deliberado).
const RESULTADO_POR_ESTADO: Record<string, string> = {
  APPROVED: 'CHARGE_SUCCESS',
  DECLINED: 'CHARGE_FAILURE',
  ERROR: 'CHARGE_FAILURE',
  VOIDED: 'CHARGE_FAILURE',
  PENDING: 'CHARGE_ACTION_REQUIRED',
}

interface TransactionInitializePayload {
  transaction: { id: string; pspReference: string }
  action: { amount: number; currency: string }
  // `data` es el `paymentData` que compone el storefront: viaja por el
  // navegador del comprador, así que NADA de aquí puede acabar siendo la
  // referencia que se manda a Wompi — sería meter un valor arbitrario dentro
  // del camino del dinero. Antes se leía un `idempotencyKey` de aquí, campo
  // que además la subscription del manifiesto nunca pide (`src/index.ts:82`):
  // el `idempotencyKey` real de Saleor es un argumento de nivel superior de
  // `transactionInitialize`, no parte de `data`.
  data?: {
    method?: string
    // NEQUI
    phone_number?: string
    // PSE + BANCOLOMBIA_TRANSFER
    user_type?: string
    payment_description?: string
    // PSE only
    user_legal_id_type?: string
    user_legal_id?: string
    financial_institution_code?: string
    // CARD (B-707): token producido por el navegador con la llave pública. `unknown`
    // a propósito: se valida en `lib/tarjeta.ts` antes de tocar nada.
    token?: unknown
    installments?: unknown
  }
  sourceObject?: { email?: string; billingAddress?: { email?: string } }
}

export async function transactionInitializeHandler(req: FastifyRequest, reply: FastifyReply) {
  // El plazo global cuenta desde la llegada de la petición (B-1078): Saleor ya está contando sus 18 s.
  const plazo = crearPlazo(PLAZO_GLOBAL_MS, 'Plazo global del inicio agotado')
  // Logger de la petición con las claves canónicas ya puestas: todo lo que se
  // escriba a partir de aquí las lleva sin repetirlas a mano. Se construye ANTES
  // de verificar la firma para que también quede constancia de lo que se rechaza.
  const log = req.log.child({ webhook: 'transaction-initialize-session', ...camposDeCorrelacion(req.body) })
  log.info('Webhook de Saleor recibido')

  try {
    await verifySaleorWebhook((req as any).rawBody, req.headers['saleor-signature'] as string, process.env.SALEOR_API_URL ?? '')
  } catch (e) {
    // `reason` distingue "clave rotada, se resuelve sola" de "alguien está
    // probando suerte": son incidentes distintos y sin esto se ven igual.
    if (e instanceof SaleorWebhookError) log.warn({ motivo: e.reason }, e.message)
    else log.warn({ error: String(e) }, 'Fallo inesperado verificando la firma de Saleor')
    return reply.status(401).send({ error: 'Invalid signature' })
  }

  const payload = req.body as TransactionInitializePayload
  const { transaction, action, data, sourceObject } = payload

  const reference = referenciaParaWompi(transaction.id)
  const method = data?.method ?? 'BANCOLOMBIA_TRANSFER'
  const phoneNumber = data?.phone_number
  const customerEmail = sourceObject?.email ?? sourceObject?.billingAddress?.email ?? ''
  const storefrontUrl = process.env.STOREFRONT_URL ?? 'http://localhost:3000'

  if (action.currency !== 'COP') {
    log.error({ currency: action.currency }, 'Wompi only supports COP — configure default-channel currency to COP in Saleor')
    return reply.send({
      result: 'CHARGE_FAILURE',
      amount: action.amount,
      message: `Wompi no soporta ${action.currency}. El canal debe usar moneda COP.`,
    })
  }

  // CARD: se valida ANTES de hablar con Wompi (ni siquiera el acceptance token).
  // Sin log del token: es credencial de un solo uso del comprador.
  const tarjeta = method === 'CARD' ? validarDatosTarjeta(data) : undefined
  if (tarjeta && !tarjeta.ok) {
    log.warn({ metodo: method }, 'paymentData de CARD inválido: se rechaza sin llamar a Wompi')
    return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: tarjeta.message })
  }

  // Una sola señal (`plazo.signal`) para token + creación. El temporizador nace al leerla (los return
  // tempranos no dejan nada vivo) y se limpia en `finally`.
  // 'token': aún no existe nada en Wompi. 'crear': la transacción pudo crearse aunque la respuesta no llegue.
  let fase: 'token' | 'crear' = 'token'
  let client: ReturnType<typeof wompiClient> | undefined

  try {
    // Saleor sends COP (e.g. 120000). Wompi expects centavos (12000000).
    const amountInCents = copToCents(action.amount)
    client = wompiClient()
    const acceptanceToken = await client.getAcceptanceToken(plazo.signal)

    let paymentMethod: NonNullable<Parameters<typeof client.createTransaction>[0]['paymentMethod']>
    switch (method) {
      case 'PSE':
        paymentMethod = {
          type: 'PSE',
          user_type: data?.user_type ?? 'PERSON',
          user_legal_id_type: data?.user_legal_id_type ?? 'CC',
          user_legal_id: data?.user_legal_id ?? '',
          financial_institution_code: data?.financial_institution_code ?? '',
          payment_description: data?.payment_description ?? 'Pago en Licona',
        }
        break
      case 'BANCOLOMBIA_TRANSFER':
        paymentMethod = {
          type: 'BANCOLOMBIA_TRANSFER',
          user_type: data?.user_type ?? 'PERSON',
          payment_description: data?.payment_description ?? 'Pago en Licona',
        }
        break
      case 'NEQUI':
        paymentMethod = phoneNumber
          ? { type: 'NEQUI', phone_number: phoneNumber }
          : { type: 'NEQUI' }
        break
      case 'CARD':
        // `tarjeta` es ok aquí: el caso inválido ya respondió arriba.
        paymentMethod = { type: 'CARD', ...(tarjeta as { ok: true; tarjeta: { token: string; installments: number } }).tarjeta }
        break
      default:
        paymentMethod = { type: method }
    }

    fase = 'crear'
    const wompiTxn = await client.createTransaction(
      {
      amountInCents,
      currency: 'COP',
      customerEmail,
      reference,
      redirectUrl: `${storefrontUrl}/checkout/orden/${transaction.id}`,
      acceptanceToken,
      paymentMethod,
      },
      plazo.signal,
    )

    // Camino feliz explícito: aquí es donde el hilo de Saleor se ata al de
    // Wompi (el id de Wompi pasa a ser el pspReference). Sin esta línea la
    // cadena solo se puede reconstruir cuando algo falla.
    log.info({ pspReference: wompiTxn.id, metodo: method }, 'Transacción creada en Wompi')

    return reply.send({
      result: 'CHARGE_ACTION_REQUIRED',
      amount: action.amount,
      pspReference: wompiTxn.id,
      actions: accionesParaResultado('CHARGE_ACTION_REQUIRED'),
      data: { redirectUrl: wompiTxn.redirect_url, wompiTransactionId: wompiTxn.id },
    })
  } catch (error) {
    // Antes de crear no hay transacción en Wompi: el fallo es cierto.
    if (fase === 'token') {
      log.error({ err: error, fase, metodo: method, amount: action.amount }, 'No se pudo obtener el acceptance token de Wompi')
      return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: MENSAJE_SIN_TRANSACCION })
    }
    // B-1095: 422 «referencia duplicada» = la huérfana de un inicio ambiguo previo existe. No es un rechazo del
    // comprador: se busca por `reference` y se responde con lo que Wompi tiene.
    const duplicada = esReferenciaDuplicada(error)
    // Rechazo cierto: 4xx al crear (422 por otro motivo, 400 token inválido...).
    if (esRechazoDefinitivo(error) && !duplicada) {
      log.error({ err: error, status: error.status }, 'Wompi rechazó crear la transacción')
      return reply.send({ result: 'CHARGE_FAILURE', amount: action.amount, message: MENSAJE_RECHAZO })
    }
    // B-1060: CHARGE_FAILURE es final en Saleor. Un timeout, fallo de red, 5xx o 408/429 al CREAR dejan el
    // estado DESCONOCIDO (la transacción pudo crearse). CHARGE_ACTION_REQUIRED admite `pspReference` opcional;
    // el webhook de Wompi y la conciliación resuelven por `reference`, que no depende del pspReference.
    const nivel = plazo.signal.aborted ? 'warn' : 'error'
    log[nivel](
      { err: error, reference, metodo: method, amount: action.amount, referenciaDuplicada: duplicada },
      duplicada
        ? 'Wompi: referencia duplicada al crear; se busca la transacción existente por reference'
        : 'Estado de la transacción en Wompi desconocido; se intenta localizarla por reference',
    )
    const existente = await buscarPorReferencia(client, reference, plazo.signal, log)
    if (existente) {
      const result = RESULTADO_POR_ESTADO[existente.status] ?? 'CHARGE_ACTION_REQUIRED'
      log.info({ pspReference: existente.id, estadoWompi: existente.status, result }, 'Transacción localizada en Wompi por reference')
      return reply.send({
        result,
        amount: action.amount,
        pspReference: existente.id,
        actions: accionesParaResultado(result),
        ...(result === 'CHARGE_ACTION_REQUIRED'
          ? { data: { ...(existente.redirect_url ? { redirectUrl: existente.redirect_url } : {}), wompiTransactionId: existente.id } }
          : {}),
      })
    }
    return reply.send({
      result: 'CHARGE_ACTION_REQUIRED',
      amount: action.amount,
      actions: accionesParaResultado('CHARGE_ACTION_REQUIRED'),
      message: MENSAJE_DESCONOCIDO,
    })
  } finally {
    plazo.limpiar()
  }
}

/**
 * Busca en Wompi la transacción de esta `reference` (B-1095). Solo si queda plazo; devuelve la transacción únicamente
 * si hay UNA coincidencia exacta. Cero (aún no indexada / nunca creada), varias (no debería: Wompi exige referencia
 * única; no se adivina) o cualquier fallo -> `undefined`, y el llamador responde ACTION_REQUIRED sin pspReference.
 */
async function buscarPorReferencia(
  client: { findTransactionsByReference(reference: string, plazo?: AbortSignal): Promise<WompiTransaction[]> } | undefined,
  reference: string,
  plazo: AbortSignal,
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
): Promise<WompiTransaction | undefined> {
  if (!client || plazo.aborted) return undefined
  try {
    // Defensa en profundidad: aunque el cliente ya filtra, aquí no se mapea nada con otra referencia.
    const exactas = (await client.findTransactionsByReference(reference, plazo)).filter((t) => t.reference === reference)
    if (exactas.length === 1) return exactas[0]
    log.warn({ reference, coincidencias: exactas.length }, 'Búsqueda por reference sin una coincidencia única; no se asocia ninguna transacción')
  } catch (err) {
    log.error({ err, reference }, 'Falló la búsqueda por reference en Wompi; se responde sin pspReference')
  }
  return undefined
}
