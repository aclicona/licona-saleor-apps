/**
 * Correlación de peticiones por CLAVES DE DOMINIO.
 *
 * El problema que resuelve: un pago atraviesa storefront → Saleor → esta App →
 * Wompi → esta App → Saleor, y hasta ahora cada salto escribía en su log con
 * los nombres que le apetecía (o no escribía nada en el camino feliz). Ante un
 * "no me llegó el pago" no había forma de juntar las líneas de los dos lados.
 *
 * No se inventa un identificador nuevo. Se usan las claves que **ya viajan** en
 * los payloads y que además son verificables contra Saleor, con nombres
 * canónicos idénticos a los del storefront:
 *
 *  - `checkoutId`     — id del checkout de Saleor. Hilo primario.
 *  - `transactionId`  — id de la transacción de Saleor.
 *  - `pspReference`   — referencia de la pasarela.
 *
 * Qué trae cada suscripción (verificado contra el manifiesto en `index.ts`):
 *
 * | Evento                             | checkoutId | transactionId | pspReference |
 * |------------------------------------|:----------:|:-------------:|:------------:|
 * | PAYMENT_GATEWAY_INITIALIZE_SESSION |     sí     |       —       |      —       |
 * | TRANSACTION_INITIALIZE_SESSION     |     sí     |      sí       |      sí      |
 * | TRANSACTION_PROCESS_SESSION        |     —      |      sí       |      sí      |
 * | CHARGE / REFUND / CANCELATION      |     —      |      sí       |      sí      |
 *
 * `TRANSACTION_INITIALIZE_SESSION` es el evento que **ata el hilo**: es el
 * único con las dos claves a la vez, y por eso el resto puede prescindir de
 * `checkoutId` sin romper la cadena. No se tocan las queries del manifiesto
 * para "arreglar" eso: cambiarlas obligaría a reinstalar las Apps (Saleor
 * guarda la query en la instalación) y en refund/cancelation el `sourceObject`
 * ya es un Order, donde el checkoutId genuinamente no existe.
 */

/** Campos canónicos. Solo aparecen los que el payload traía de verdad. */
export interface CamposCorrelacion {
  checkoutId?: string
  transactionId?: string
  pspReference?: string
}

/**
 * Longitud máxima aceptada para un valor de correlación.
 *
 * El cuerpo se lee ANTES de verificar la firma de Saleor (así queda constancia
 * también de lo que se rechaza), así que un atacante controla estos valores.
 * Un id de Saleor es un global ID en base64 de ~50 caracteres; 512 deja
 * muchísimo margen y a la vez impide que un campo de 10 MB se convierta en una
 * línea de log de 10 MB repetida en cada línea del handler.
 */
export const LONGITUD_MAXIMA_VALOR = 512

/**
 * Acepta solo cadenas no vacías y acotadas. Cualquier otra cosa (número, null,
 * objeto, cadena kilométrica) se descarta: un campo de correlación con basura
 * dentro es peor que su ausencia, porque parece correlación y no lo es.
 */
function valorUtil(valor: unknown): string | undefined {
  if (typeof valor !== 'string') return undefined
  const limpio = valor.trim()
  if (!limpio || limpio.length > LONGITUD_MAXIMA_VALOR) return undefined
  return limpio
}

/** Lectura de propiedad que no lanza sobre `null`, primitivos ni `undefined`. */
function prop(objeto: unknown, clave: string): unknown {
  if (typeof objeto !== 'object' || objeto === null) return undefined
  return (objeto as Record<string, unknown>)[clave]
}

/**
 * Extrae los campos canónicos del cuerpo de un webhook **de Saleor**.
 *
 * Contrato: NUNCA lanza. Se llama en la primera línea de cada handler, antes de
 * validar nada, y un fallo aquí convertiría un payload malformado (que hoy se
 * responde con un 401 o un CHARGE_FAILURE limpio) en un 500 sin diagnóstico.
 * Ante la duda, devuelve menos campos — nunca una excepción.
 */
export function camposDeCorrelacion(cuerpo: unknown): CamposCorrelacion {
  const campos: CamposCorrelacion = {}

  const sourceObject = prop(cuerpo, 'sourceObject')
  // `__typename` no se pide en ninguna query del manifiesto, así que casi
  // siempre será undefined. Cuando venga, se respeta: en refund/cancelation el
  // sourceObject es un Order, y etiquetar el id de una orden como `checkoutId`
  // sería correlacionar mal, que es peor que no correlacionar.
  const tipo = prop(sourceObject, '__typename')
  if (tipo === undefined || tipo === 'Checkout') {
    const checkoutId = valorUtil(prop(sourceObject, 'id'))
    if (checkoutId) campos.checkoutId = checkoutId
  }

  const transaction = prop(cuerpo, 'transaction')
  const transactionId = valorUtil(prop(transaction, 'id'))
  if (transactionId) campos.transactionId = transactionId

  const pspReference = valorUtil(prop(transaction, 'pspReference'))
  if (pspReference) campos.pspReference = pspReference

  return campos
}

/**
 * Extrae los campos canónicos del cuerpo de un evento **entrante de Wompi**.
 *
 * Es otra función y no un parámetro de la anterior porque el payload es de otro
 * emisor y de otra forma: aquí no hay `transaction.id` de Saleor. La única
 * clave de unión con el resto de la cadena es el id de la transacción en Wompi,
 * que es exactamente el `pspReference` que la App reporta a Saleor.
 *
 * `data.transaction.reference` NO se mapea a `transactionId` a propósito: hoy
 * ese campo lo rellena `transaction-initialize` con `idempotencyKey ?? id`, así
 * que puede no ser un id de transacción de Saleor. Etiquetarlo como tal daría
 * una correlación falsa.
 *
 * Contrato: NUNCA lanza.
 */
export function camposDeCorrelacionWompi(evento: unknown): CamposCorrelacion {
  const campos: CamposCorrelacion = {}

  const transaccion = prop(prop(evento, 'data'), 'transaction')
  const pspReference = valorUtil(prop(transaccion, 'id'))
  if (pspReference) campos.pspReference = pspReference

  return campos
}
