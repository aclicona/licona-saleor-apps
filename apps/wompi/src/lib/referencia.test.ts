import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { referenciaParaWompi, transactionIdDesdeReferencia } from './referencia.js'

/**
 * Este archivo es el dueño ejecutable del invariante del camino del dinero:
 *
 *   lo que se le manda a Wompi como `reference` TIENE que poder volver a ser el
 *   ID de transacción de Saleor cuando el evento entrante lo devuelva.
 *
 * Si ese round-trip se rompe, `wompi-incoming` llama a `transactionEventReport`
 * con un id que Saleor no resuelve, recibe `NOT_FOUND`, lo clasifica —con
 * razón— como fallo permanente, responde 200, y Wompi deja de reintentar. La
 * confirmación de un pago real desaparece sin dejar un error visible en ningún
 * sitio. Por eso el round-trip se prueba aquí y no se deja implícito en el
 * handler: es la única capa donde el fallo se ve antes de costar dinero.
 */

/** Prefijo del tipo relay que Saleor exige para resolver una transacción. */
const PREFIJO = 'TransactionItem:'

/** Codifica como lo hace `graphene.Node.to_global_id`. */
function enBase64(texto: string): string {
  return Buffer.from(texto, 'utf8').toString('base64')
}

/**
 * Genera un ID global de transacción con el formato REAL que emite el fork:
 * `base64("TransactionItem:<uuid>")`, porque `TransactionItem.resolve_id`
 * devuelve `root.token`, que es un UUID
 * (`saleor/graphql/payment/types.py:668`). Se generan al vuelo en vez de fijar
 * una constante para que el round-trip se ejercite con valores distintos en
 * cada corrida: un bug que dependa de un byte concreto del base64 (relleno,
 * `+`, `/`) no se esconde detrás de un único fixture afortunado.
 */
function idGlobalDeTransaccion(uuid: string = randomUUID()): string {
  return enBase64(`${PREFIJO}${uuid}`)
}

describe('referenciaParaWompi ↔ transactionIdDesdeReferencia — ida y vuelta', () => {
  it('recupera el id de transacción de Saleor exacto, sin perder un solo carácter', () => {
    // Varias muestras: el UUID es aleatorio, así que cada corrida cubre
    // combinaciones distintas de relleno y alfabeto base64.
    for (let i = 0; i < 25; i++) {
      const transactionId = idGlobalDeTransaccion()

      expect(transactionIdDesdeReferencia(referenciaParaWompi(transactionId))).toBe(transactionId)
    }
  })

  it('mantiene la referencia en el formato que Saleor sabe resolver: base64 de "TransactionItem:<sufijo>"', () => {
    // El round-trip contra nuestra propia inversa no basta como prueba: dos
    // funciones mutuamente consistentes pueden estar las dos equivocadas. Lo
    // que ata el test a la realidad es que la referencia siga siendo un ID
    // global relay del tipo correcto, que es lo que
    // `from_global_id_or_error(only_type=TransactionItem)` exige del otro lado
    // (`saleor/graphql/payment/mutations/transaction/utils.py:26`).
    const uuid = randomUUID()
    const referencia = referenciaParaWompi(idGlobalDeTransaccion(uuid))

    expect(Buffer.from(referencia, 'base64').toString('utf8')).toBe(`${PREFIJO}${uuid}`)
  })

  it('preserva el formato medido del fork: 72 caracteres terminados en "=="', () => {
    // Canario de formato, no capricho: si un día `referenciaParaWompi` deja de
    // ser la identidad y empieza a codificar (por ejemplo a base64url sin
    // relleno porque Wompi rechaza el `=`), este test se pone rojo y obliga a
    // revisar a la vez la inversa y lo ya emitido en producción — que es
    // exactamente la conversación que hay que tener antes de cambiar el
    // formato de algo que ya viajó a la pasarela.
    const referencia = referenciaParaWompi(idGlobalDeTransaccion())

    expect(referencia).toHaveLength(72)
    expect(referencia.endsWith('==')).toBe(true)
  })

  it('acepta el formato legacy anterior a 3.13, donde el sufijo era un entero', () => {
    // Deliberado: `get_transaction_item` de Saleor todavía resuelve esas
    // transacciones (`.../transaction/utils.py:29`). Rechazarlas aquí sería
    // provocar el mismo `NOT_FOUND` que este módulo existe para evitar, sobre
    // un id que Saleor sí habría resuelto.
    const legacy = enBase64(`${PREFIJO}123`)

    expect(transactionIdDesdeReferencia(legacy)).toBe(legacy)
  })
})

describe('transactionIdDesdeReferencia — referencias que no son un id de Saleor', () => {
  /**
   * La referencia llega en un cuerpo HTTP de Wompi, así que puede ser
   * cualquier cosa por causas perfectamente reales: una cuenta de comercio
   * compartida con otra integración, una transacción creada a mano en el panel
   * de Wompi, un cruce entre sandbox y producción. Ante todas ellas la
   * respuesta correcta es `undefined` —un "esto no es mío" que el handler
   * puede registrar con sentido— y NUNCA una excepción, porque se llama en el
   * camino del dinero antes de decidir el código de respuesta y una excepción
   * aquí se comería el evento entero.
   */
  it.each([
    ['cadena vacía', ''],
    ['undefined', undefined],
    ['null', null],
    ['número', 42],
    ['objeto', { id: 'VHJhbnNhY3Rpb25JdGVtOjE=' }],
    ['array', ['VHJhbnNhY3Rpb25JdGVtOjE=']],
    ['base64 basura', '!!!!'],
    ['base64 de otro tipo relay (Checkout)', enBase64('Checkout:1')],
    ['base64 de otro tipo relay (Order)', enBase64('Order:1')],
    ['prefijo correcto con sufijo vacío', enBase64(PREFIJO)],
    ['texto plano que no es base64', 'referencia-inventada-en-el-panel-de-wompi'],
    ['clave de idempotencia que el comprador podría haber inyectado', 'clave-del-storefront'],
    ['prefijo parecido pero de otro tipo', enBase64('TransactionItemEvent:abc')],
  ])('devuelve undefined y no lanza ante %s', (_titulo, referencia) => {
    expect(() => transactionIdDesdeReferencia(referencia)).not.toThrow()
    expect(transactionIdDesdeReferencia(referencia)).toBeUndefined()
  })
})
