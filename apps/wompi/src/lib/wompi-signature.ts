/**
 * Verificación de la firma de los eventos entrantes de Wompi.
 *
 * ── Por qué existe este módulo ───────────────────────────────────────────────
 * El handler implementaba un algoritmo que Wompi no usa: HMAC-SHA256 sobre
 * `rawBody + timestamp + secret`, con el timestamp y el checksum leídos de las
 * cabeceras `x-event-created-at` y `x-signature`. Tres divergencias
 * independientes respecto de la especificación (https://docs.wompi.co/en/docs/colombia/eventos/):
 *
 *   1. Wompi usa **SHA-256 simple**, no HMAC. La doc muestra `hash("sha256", $cadena)`
 *      en PHP y `Digest::SHA256.hexdigest` en Ruby. El código anterior metía el
 *      secreto dos veces (dentro del mensaje y como clave HMAC); no hay lectura
 *      de la doc bajo la que eso coincida.
 *   2. **No se firma el cuerpo entero**, sino la concatenación SIN separadores de
 *      los *valores* de las propiedades que el propio evento enumera en
 *      `signature.properties`, seguidos del `signature.timestamp` y del secreto.
 *   3. Las cabeceras que leía **no existen**: el checksum llega en `X-Event-Checksum`
 *      y en `signature.checksum`; el timestamp llega solo en `signature.timestamp`.
 *
 * Consecuencia del bug: no existía configuración en la que el webhook funcionara.
 * Con el secreto puesto, esas cabeceras llegaban vacías y TODA confirmación
 * legítima de Wompi se rechazaba con 401 — pagos reales que nunca se confirman.
 *
 * ── El algoritmo, tal como lo documenta Wompi ────────────────────────────────
 * Dado el evento, se concatenan en este orden y sin separador alguno:
 *
 *   1. el valor de cada ruta de `signature.properties`, EN EL ORDEN DE LA LISTA,
 *      resuelta contra `data` (`"transaction.id"` → `data.transaction.id`);
 *   2. `signature.timestamp`;
 *   3. el secreto de eventos.
 *
 * y se le aplica SHA-256. Ejemplo literal de la doc:
 *
 *   1234-1610641025-49201APPROVED44900001530291411prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z
 *   └──── transaction.id ────┘└status┘└ cents ┘└timestamp┘└──────── secreto ────────┘
 *
 * ── `properties` NO se codifica fija ─────────────────────────────────────────
 * La doc advierte explícitamente que la lista «puede variar con el tiempo y en
 * cada evento». Codificar `[transaction.id, transaction.status,
 * transaction.amount_in_cents]` funcionaría hoy y empezaría a rechazar eventos
 * legítimos el día que Wompi añada un campo, sin ningún cambio por nuestra
 * parte. Por eso la resolución de rutas es genérica y guiada por el evento.
 *
 * ── Postura ante lo dudoso: rechazar ─────────────────────────────────────────
 * Esto decide si una orden se marca como pagada. Cualquier evento que no
 * permita reconstruir EXACTAMENTE la cadena documentada se rechaza; no se
 * inventan valores por defecto ni se omiten campos irresolubles. Omitir un
 * campo que no se sabe resolver sería regalarle al atacante la posibilidad de
 * borrar el importe del evento y seguir firmando.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Nombre de la cabecera HTTP que Wompi usa para el checksum. */
export const CABECERA_CHECKSUM = 'x-event-checksum'

/** Longitud en caracteres hex de un digest SHA-256. */
const LONGITUD_CHECKSUM_HEX = 64

/** Un checksum válido es exactamente un SHA-256 en hex; la doc lo publica en mayúsculas. */
const CHECKSUM_HEX = /^[0-9a-fA-F]{64}$/

/** El timestamp documentado es un entero UNIX; se admite también su forma en texto. */
const SOLO_DIGITOS = /^\d+$/

/**
 * Claves que nunca se recorren al resolver una ruta de `signature.properties`.
 * Sin esto, un evento con `properties: ["constructor.name"]` resolvería contra
 * la cadena de prototipos en lugar de contra los datos del evento, y el valor
 * firmado dejaría de ser un dato que Wompi controla.
 */
const CLAVES_PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype'])

/** Motivo por el que un evento se rechaza. Se registra en logs; nunca incluye el secreto. */
export type MotivoFirmaInvalida =
  | 'SIN_BLOQUE_SIGNATURE'
  | 'PROPERTIES_INVALIDO'
  | 'PROPERTIES_VACIO'
  | 'PROPIEDAD_IRRESOLUBLE'
  | 'TIMESTAMP_INVALIDO'
  | 'CHECKSUM_AUSENTE'
  | 'CHECKSUM_MALFORMADO'
  | 'CHECKSUM_INCONSISTENTE'
  | 'SECRETO_AUSENTE'
  | 'CHECKSUM_NO_COINCIDE'

export type ResultadoFirma =
  | { valido: true }
  | { valido: false; motivo: MotivoFirmaInvalida; detalle: string }

/** Forma mínima del evento que esta verificación necesita. El resto del cuerpo no se firma. */
export interface EventoFirmado {
  data?: unknown
  signature?: {
    properties?: unknown
    checksum?: unknown
    timestamp?: unknown
  }
}

function invalido(motivo: MotivoFirmaInvalida, detalle: string): ResultadoFirma {
  return { valido: false, motivo, detalle }
}

/**
 * Resuelve una ruta con puntos (`"transaction.amount_in_cents"`) contra el
 * objeto `data` del evento y devuelve su representación en texto tal como entra
 * en la cadena a firmar.
 *
 * Devuelve `undefined` cuando la ruta no existe o su valor no es un escalar.
 * Se aceptan string, número finito y booleano porque los tres tienen una
 * representación textual única y estable; se rechazan `null`, `undefined`,
 * objetos y arrays porque su serialización sería una elección nuestra, no de
 * Wompi, y cualquier elección distinta a la suya produce un checksum distinto.
 */
function resolverValor(data: unknown, ruta: string): string | undefined {
  if (typeof ruta !== 'string' || ruta.length === 0) return undefined

  let actual: unknown = data
  for (const segmento of ruta.split('.')) {
    if (segmento.length === 0 || CLAVES_PROHIBIDAS.has(segmento)) return undefined
    if (actual === null || typeof actual !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(actual, segmento)) return undefined
    actual = (actual as Record<string, unknown>)[segmento]
  }

  if (typeof actual === 'string') return actual
  if (typeof actual === 'number') return Number.isFinite(actual) ? String(actual) : undefined
  if (typeof actual === 'boolean') return String(actual)
  return undefined
}

/**
 * Construye la cadena exacta que Wompi firma para un evento dado.
 * Se exporta para poder verificarla contra el ejemplo literal de la doc: es la
 * pieza que hay que poder auditar a ojo frente a la especificación.
 *
 * Devuelve `null` si el evento no permite reconstruirla; el motivo concreto lo
 * determina `verificarFirmaWompi`, que es quien tiene que reportarlo.
 */
export function construirCadenaAFirmar(evento: EventoFirmado, secret: string): string | null {
  const propiedades = evento?.signature?.properties
  if (!Array.isArray(propiedades) || propiedades.length === 0) return null

  const valores: string[] = []
  for (const ruta of propiedades) {
    const valor = resolverValor(evento?.data, ruta as string)
    if (valor === undefined) return null
    valores.push(valor)
  }

  const timestamp = normalizarTimestamp(evento?.signature?.timestamp)
  if (timestamp === null) return null

  return valores.join('') + timestamp + secret
}

/**
 * Normaliza `signature.timestamp` a su forma textual. Wompi lo envía como
 * entero UNIX; se admite además la cadena de dígitos equivalente porque su
 * representación es idéntica y aceptarla no relaja nada. Cualquier otra cosa
 * (decimal, negativo, texto, ausente) se rechaza.
 */
function normalizarTimestamp(timestamp: unknown): string | null {
  if (typeof timestamp === 'number') {
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? String(timestamp) : null
  }
  if (typeof timestamp === 'string' && SOLO_DIGITOS.test(timestamp)) return timestamp
  return null
}

/**
 * Compara dos checksums hex en tiempo constante.
 *
 * Se normaliza a minúsculas antes de convertir porque la doc publica el
 * checksum en MAYÚSCULAS y `createHash().digest('hex')` lo produce en
 * minúsculas: comparar los bytes decodificados hace la comparación insensible a
 * mayúsculas sin recurrir a una comparación de cadenas con cortocircuito.
 *
 * El formato se valida ANTES de decodificar: `Buffer.from(x, 'hex')` trunca en
 * silencio ante un carácter no hexadecimal (`'ab!cd'` → 1 byte), así que sin
 * este filtro una cadena malformada llegaría a `timingSafeEqual` con otra
 * longitud y lanzaría. Validar el formato no filtra nada por tiempo: que el
 * checksum sean 64 caracteres hex es público, no depende del secreto.
 */
function checksumsIguales(recibido: string, esperado: string): boolean {
  if (!CHECKSUM_HEX.test(recibido)) return false

  const bufRecibido = Buffer.from(recibido.toLowerCase(), 'hex')
  const bufEsperado = Buffer.from(esperado.toLowerCase(), 'hex')
  if (bufRecibido.length !== bufEsperado.length) return false

  return timingSafeEqual(bufRecibido, bufEsperado)
}

/** Extrae el checksum del cuerpo si viene y es una cadena no vacía. */
function checksumDelCuerpo(evento: EventoFirmado): string | undefined {
  const checksum = evento?.signature?.checksum
  return typeof checksum === 'string' && checksum.trim() !== '' ? checksum.trim() : undefined
}

/**
 * Verifica la firma de un evento entrante de Wompi.
 *
 * @param evento Cuerpo del evento YA PARSEADO. A diferencia del JWS de Saleor,
 *   aquí NO hace falta el `rawBody`: la firma no cubre los bytes del cuerpo sino
 *   valores concretos, así que reparsear no puede alterar lo que se firma.
 * @param checksumCabecera Valor de `X-Event-Checksum`, si vino.
 * @param secret `WOMPI_EVENTS_SECRET`.
 *
 * ── Casos degenerados y por qué se resuelven así ─────────────────────────────
 * Todos rechazan. El criterio único: si no se puede reconstruir la cadena
 * documentada y compararla contra un checksum bien formado, no hay prueba de
 * que el evento venga de Wompi, y sin esa prueba no se marca nada como pagado.
 *
 * - **Falta el bloque `signature`** → rechazo. Sin él no hay ni qué firmar ni
 *   contra qué comparar. Es además la forma exacta de un POST anónimo.
 * - **`properties` vacío o no es array** → rechazo. Con la lista vacía la cadena
 *   sería solo `timestamp + secreto`: un checksum válido para un evento serviría
 *   para CUALQUIER otro cuerpo con el mismo timestamp. Sería una firma que no
 *   firma nada, y aceptarla es peor que no verificar, porque parece verificación.
 * - **Una propiedad no existe en `data`** (o no es escalar) → rechazo. La
 *   alternativa —tratarla como cadena vacía— dejaría que un atacante borrase
 *   `amount_in_cents` del evento y siguiese produciendo un checksum válido.
 * - **Checksum ausente en cabecera y cuerpo** → rechazo. No hay nada que comparar.
 * - **Checksum presente en ambos sitios pero distintos** → rechazo. Son copias
 *   redundantes del MISMO valor por conveniencia (la cabecera evita parsear el
 *   cuerpo); que difieran significa que alguien tocó una de las dos. Se exige que
 *   TODA copia presente coincida con el checksum calculado, no solo una: aceptar
 *   «que cuadre alguna» convertiría dos copias en dos intentos.
 * - **`timestamp` ausente o no entero** → rechazo. Entra literalmente en la
 *   cadena; sin él no hay cadena que calcular.
 * - **Secreto vacío** → rechazo explícito. El fail-fast del arranque
 *   (`lib/config.ts`) ya impide llegar aquí, pero si alguien reintrodujera el
 *   fallo, la verificación seguiría siendo criptográficamente sólida por
 *   accidente y no por diseño; mejor que sea por diseño.
 */
export function verificarFirmaWompi(
  evento: EventoFirmado | undefined | null,
  checksumCabecera: string | undefined,
  secret: string,
): ResultadoFirma {
  if (typeof secret !== 'string' || secret === '') {
    return invalido('SECRETO_AUSENTE', 'WOMPI_EVENTS_SECRET vacío: no se puede verificar ninguna firma')
  }

  if (!evento || typeof evento !== 'object' || !evento.signature || typeof evento.signature !== 'object') {
    return invalido('SIN_BLOQUE_SIGNATURE', 'El evento no trae el objeto signature')
  }

  const propiedades = evento.signature.properties
  if (!Array.isArray(propiedades)) {
    return invalido('PROPERTIES_INVALIDO', 'signature.properties no es un array')
  }
  if (propiedades.length === 0) {
    return invalido('PROPERTIES_VACIO', 'signature.properties está vacío: la firma no cubriría ningún dato del evento')
  }

  for (const ruta of propiedades) {
    if (resolverValor(evento.data, ruta as string) === undefined) {
      return invalido(
        'PROPIEDAD_IRRESOLUBLE',
        `signature.properties nombra "${String(ruta)}", que no existe en data o no es un valor escalar`,
      )
    }
  }

  if (normalizarTimestamp(evento.signature.timestamp) === null) {
    return invalido('TIMESTAMP_INVALIDO', 'signature.timestamp ausente o no es un entero UNIX')
  }

  const delCuerpo = checksumDelCuerpo(evento)
  const deCabecera = typeof checksumCabecera === 'string' && checksumCabecera.trim() !== '' ? checksumCabecera.trim() : undefined

  const recibidos = [deCabecera, delCuerpo].filter((c): c is string => c !== undefined)
  if (recibidos.length === 0) {
    return invalido('CHECKSUM_AUSENTE', `Sin checksum ni en ${CABECERA_CHECKSUM} ni en signature.checksum`)
  }
  if (recibidos.some((c) => !CHECKSUM_HEX.test(c))) {
    return invalido('CHECKSUM_MALFORMADO', 'El checksum recibido no es un SHA-256 en hexadecimal de 64 caracteres')
  }
  if (recibidos.length === 2 && recibidos[0]!.toLowerCase() !== recibidos[1]!.toLowerCase()) {
    return invalido(
      'CHECKSUM_INCONSISTENTE',
      `El checksum de ${CABECERA_CHECKSUM} y el de signature.checksum no coinciden entre sí`,
    )
  }

  // La cadena ya no puede ser null: todo lo que la impide se validó arriba con
  // un motivo específico. El guard queda por si el orden cambia en el futuro.
  const cadena = construirCadenaAFirmar(evento, secret)
  if (cadena === null) {
    return invalido('PROPIEDAD_IRRESOLUBLE', 'No se pudo construir la cadena a firmar')
  }

  const esperado = createHash('sha256').update(cadena, 'utf8').digest('hex')
  if (esperado.length !== LONGITUD_CHECKSUM_HEX) {
    return invalido('CHECKSUM_MALFORMADO', 'El digest calculado no tiene la longitud de un SHA-256')
  }

  if (!recibidos.every((recibido) => checksumsIguales(recibido, esperado))) {
    return invalido('CHECKSUM_NO_COINCIDE', 'El checksum recibido no corresponde a este evento')
  }

  return { valido: true }
}
