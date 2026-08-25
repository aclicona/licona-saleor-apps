/**
 * La referencia que viaja a Wompi y vuelve.
 *
 * ── Por qué existe este módulo ──────────────────────────────────────────────
 * Hay un invariante que ata los dos webhooks del camino del dinero y que hasta
 * ahora no vivía en ninguna parte:
 *
 *   **La `reference` que se le manda a Wompi TIENE que poder volver a ser el
 *   ID de transacción de Saleor.**
 *
 * Porque el evento entrante de Wompi devuelve esa misma referencia
 * (`data.transaction.reference`) y `wompi-incoming.ts` la usa directamente como
 * `id` de `transactionEventReport`. Si la referencia deja de ser un ID de
 * Saleor, la mutación responde `NOT_FOUND`, el handler lo trata —con razón—
 * como fallo permanente, responde 200, Wompi deja de reintentar y **la
 * confirmación de un pago real se pierde para siempre**.
 *
 * Antes, el invariante estaba a un `??` de romperse: `transaction-initialize`
 * hacía `data?.idempotencyKey ?? transaction.id`, y `data` es el `paymentData`
 * que el comprador controla desde el storefront. Nadie usaba esa rama, pero
 * cualquiera podía activarla — desde el navegador, sin tocar el servidor.
 *
 * ── Por qué un módulo y no una asignación ───────────────────────────────────
 * Hoy `referenciaParaWompi` es la identidad, y eso es correcto: el ID global de
 * Saleor ya es una referencia válida. El módulo no está aquí por lo que hace
 * hoy, sino porque le da al invariante un **dueño ejecutable**: un test de ida
 * y vuelta que se pone rojo si alguien lo viola, en vez de un comentario que
 * nadie lee. Y es el sitio donde tiene que ir la codificación el día que una
 * pasarela no acepte el formato crudo (ver la nota de charset abajo).
 *
 * ── Formato del ID, verificado contra el fork (2026-08-25) ──────────────────
 * `TransactionItem.resolve_id` devuelve `root.token`, un UUID
 * (`saleor/graphql/payment/types.py:668`), pero graphene lo entrega como ID
 * global relay: `base64("TransactionItem:<uuid>")`. Confirmado en los tests de
 * upstream, que construyen el payload esperado con
 * `graphene.Node.to_global_id("TransactionItem", transaction.token)`
 * (`saleor/webhook/tests/subscription_webhooks/test_create_deliveries_for_transaction_initialize_session.py:113`).
 * Y `transactionEventReport` lo resuelve de vuelta con
 * `from_global_id_or_error(only_type=TransactionItem)`
 * (`saleor/graphql/payment/mutations/transaction/utils.py:26`), así que el
 * formato que hay que preservar es el ID global, no el UUID pelado.
 *
 * Medido: **72 caracteres**, siempre terminados en `==`, y sobre 200 000
 * muestras **nunca** aparecen `+` ni `/` — el contenido es ASCII de un alfabeto
 * hexadecimal, así que el base64 sale alfanumérico salvo el relleno.
 *
 * ⚠️ **Sin verificar contra Wompi:** que una referencia de 72 caracteres
 * terminada en `==` sea aceptable. Wompi documenta referencias alfanuméricas y
 * `=` no está en ese conjunto. Nunca se ha creado una transacción real contra
 * Wompi con este código. Si el día de mañana Wompi la rechaza o la trunca, el
 * arreglo es codificar aquí (base64url sin relleno, por ejemplo) y decodificar
 * en la inversa — sin tocar ni un handler. Eso es exactamente lo que este
 * módulo compra.
 */

/** Prefijo del tipo relay dentro del ID global de una transacción de Saleor. */
const PREFIJO_TRANSACTION_ITEM = 'TransactionItem:'

/**
 * Construye la referencia que se le manda a Wompi a partir del ID de
 * transacción de Saleor.
 *
 * Hoy es la identidad. **No** es un envoltorio inútil: es el único punto por el
 * que puede entrar una codificación, y su existencia es lo que hace verificable
 * el round-trip con `transactionIdDesdeReferencia`.
 */
export function referenciaParaWompi(transactionId: string): string {
  return transactionId
}

/**
 * Inversa de `referenciaParaWompi`: recupera el ID de transacción de Saleor a
 * partir de la referencia que devuelve Wompi.
 *
 * Devuelve `undefined` si la referencia **no** puede ser un ID de transacción
 * de Saleor. Eso no es paranoia de tipos: la referencia llega en un cuerpo HTTP
 * de Wompi y puede ser basura por causas reales y distintas —una cuenta de
 * comercio compartida con otra integración, una transacción de prueba creada a
 * mano en el panel, un cruce de entornos—. Llamar a `transactionEventReport`
 * con eso solo produce un `NOT_FOUND` que no dice de qué se trata.
 *
 * **Contrato: NUNCA lanza.** Se llama en el camino del dinero, antes de decidir
 * el código de respuesta; una excepción aquí se comería el evento.
 *
 * Ojo con la validación: se comprueba el prefijo del tipo, no la forma del
 * sufijo. Exigir que el sufijo sea un UUID sería atarse a un detalle que
 * upstream ya cambió una vez —las transacciones anteriores a 3.13 usaban un
 * `int` y `get_transaction_item` todavía las acepta
 * (`saleor/graphql/payment/mutations/transaction/utils.py:29`)—, y rechazar
 * aquí un ID que Saleor sí resolvería sería peor que el fallo que evitamos.
 */
export function transactionIdDesdeReferencia(referencia: unknown): string | undefined {
  if (typeof referencia !== 'string' || referencia === '') return undefined

  let decodificado: string
  try {
    decodificado = Buffer.from(referencia, 'base64').toString('utf8')
  } catch {
    // `Buffer.from(_, 'base64')` no lanza ni con basura, pero el contrato de
    // "nunca lanza" no puede depender de un detalle de implementación de Node.
    return undefined
  }

  if (!decodificado.startsWith(PREFIJO_TRANSACTION_ITEM)) return undefined
  if (decodificado.length === PREFIJO_TRANSACTION_ITEM.length) return undefined

  return referencia
}
