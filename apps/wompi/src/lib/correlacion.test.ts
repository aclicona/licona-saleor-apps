import { describe, it, expect } from 'vitest'
import {
  LONGITUD_MAXIMA_VALOR,
  camposDeCorrelacion,
  camposDeCorrelacionWompi,
} from './correlacion.js'

/**
 * El vocabulario canónico (`checkoutId`, `transactionId`, `pspReference`) es un
 * contrato con el storefront: los dos lados escriben los MISMOS nombres para
 * poder juntar las líneas de una cadena de pago. Un renombre silencioso aquí
 * rompe la correlación sin romper ningún test de comportamiento, así que los
 * nombres se fijan literalmente.
 */
const NOMBRES_CANONICOS = ['checkoutId', 'transactionId', 'pspReference']

/**
 * Referencia tal y como viaja a Wompi y vuelve: el ID global de una transacción
 * de Saleor, `base64("TransactionItem:<uuid>")`. Se escribe el literal en vez de
 * construirlo con `referenciaParaWompi` a propósito — si el formato cambiara,
 * generarlo con la misma función que se está probando dejaría el test en verde
 * mientras la correlación real se rompe.
 */
const REFERENCIA_SALEOR = 'VHJhbnNhY3Rpb25JdGVtOmEyMGVkNTc2LTNkOGMtNDliMi1iZGUzLTgwYzA3NmExNzUzYg=='

describe('camposDeCorrelacion — payload de Saleor', () => {
  it('extrae las tres claves de TRANSACTION_INITIALIZE_SESSION, que es el evento que ata el hilo', () => {
    // Es el único evento del manifiesto con checkout y transacción a la vez.
    const campos = camposDeCorrelacion({
      transaction: { id: 'VHJhbnNhY3Rpb246MQ==', pspReference: 'wompi-txn-12345' },
      sourceObject: { id: 'Q2hlY2tvdXQ6MQ==', email: 'cliente@example.com' },
      action: { amount: 120000, currency: 'COP' },
    })

    expect(campos).toEqual({
      checkoutId: 'Q2hlY2tvdXQ6MQ==',
      transactionId: 'VHJhbnNhY3Rpb246MQ==',
      pspReference: 'wompi-txn-12345',
    })
  })

  it('emite EXACTAMENTE los nombres canónicos, sin alias ni variantes de casing', () => {
    const campos = camposDeCorrelacion({
      transaction: { id: 't', pspReference: 'p' },
      sourceObject: { id: 'c' },
    })

    // `toEqual` ya compara el objeto entero, pero esto falla con un mensaje que
    // dice QUÉ nombre se ha ido, que es el fallo que importa aquí.
    expect(Object.keys(campos).sort()).toEqual([...NOMBRES_CANONICOS].sort())
  })

  it('PAYMENT_GATEWAY_INITIALIZE_SESSION: solo checkoutId, porque no hay transacción todavía', () => {
    const campos = camposDeCorrelacion({
      sourceObject: { id: 'Q2hlY2tvdXQ6MQ==', totalPrice: { gross: { amount: 120000, currency: 'COP' } } },
      data: {},
      amount: 120000,
    })

    expect(campos).toEqual({ checkoutId: 'Q2hlY2tvdXQ6MQ==' })
  })

  it('CHARGE/REFUND/CANCELATION: transactionId y pspReference, sin checkoutId', () => {
    // Esas suscripciones no piden sourceObject, y en refund/cancelation el
    // sourceObject sería un Order — el checkoutId no existe ahí.
    const campos = camposDeCorrelacion({
      transaction: { id: 'VHJhbnNhY3Rpb246MQ==', pspReference: 'wompi-txn-12345' },
      action: { amount: 120000 },
    })

    expect(campos).toEqual({ transactionId: 'VHJhbnNhY3Rpb246MQ==', pspReference: 'wompi-txn-12345' })
  })

  it('omite la clave ausente en vez de emitirla con undefined', () => {
    // Un `pspReference: undefined` en el log parece un dato perdido; su ausencia
    // dice la verdad: Saleor todavía no tenía referencia de pasarela.
    const campos = camposDeCorrelacion({ transaction: { id: 'VHJhbnNhY3Rpb246MQ==', pspReference: '' } })

    expect(campos).toEqual({ transactionId: 'VHJhbnNhY3Rpb246MQ==' })
    expect('pspReference' in campos).toBe(false)
  })

  it('no etiqueta como checkoutId el id de un Order cuando el payload trae __typename', () => {
    // Correlacionar mal es peor que no correlacionar.
    const campos = camposDeCorrelacion({
      transaction: { id: 'VHJhbnNhY3Rpb246MQ==' },
      sourceObject: { __typename: 'Order', id: 'T3JkZXI6MQ==' },
    })

    expect(campos).toEqual({ transactionId: 'VHJhbnNhY3Rpb246MQ==' })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['cadena', 'no soy un objeto'],
    ['número', 42],
    ['array', []],
    ['objeto vacío', {}],
    ['transaction null', { transaction: null }],
    ['transaction primitivo', { transaction: 'VHJhbnNhY3Rpb246MQ==' }],
    ['sourceObject null', { sourceObject: null }],
    ['ids no textuales', { transaction: { id: 12345, pspReference: { a: 1 } }, sourceObject: { id: [] } }],
  ])('no lanza y devuelve {} con payload basura: %s', (_titulo, cuerpo) => {
    // Se llama en la PRIMERA línea de cada handler, antes de validar nada: si
    // lanzara, un payload malformado pasaría de un 401 limpio a un 500 mudo.
    expect(() => camposDeCorrelacion(cuerpo)).not.toThrow()
    expect(camposDeCorrelacion(cuerpo)).toEqual({})
  })

  it('descarta valores absurdamente largos en vez de repetirlos en cada línea', () => {
    // El cuerpo se lee antes de verificar la firma, así que un atacante controla
    // estos valores. Un id de 10 MB se convertiría en 10 MB por línea de log.
    const enorme = 'x'.repeat(LONGITUD_MAXIMA_VALOR + 1)

    expect(camposDeCorrelacion({ transaction: { id: enorme } })).toEqual({})
    expect(camposDeCorrelacion({ transaction: { id: 'x'.repeat(LONGITUD_MAXIMA_VALOR) } })).toEqual({
      transactionId: 'x'.repeat(LONGITUD_MAXIMA_VALOR),
    })
  })
})

describe('camposDeCorrelacionWompi — evento entrante de la pasarela', () => {
  it('mapea data.transaction.id a pspReference, que es la clave de unión', () => {
    // Es el mismo valor que la App reporta a Saleor como pspReference.
    const campos = camposDeCorrelacionWompi({
      event: 'transaction.updated',
      data: { transaction: { id: 'wompi-txn-12345', status: 'APPROVED', reference: 'VHJhbnNhY3Rpb246MQ==' } },
    })

    expect(campos).toEqual({ pspReference: 'wompi-txn-12345' })
  })

  it('mapea data.transaction.reference a transactionId cuando es un ID de transacción de Saleor', () => {
    // Este era el único evento de la cadena sin `transactionId`: el hilo se
    // cortaba justo en el salto que confirma el dinero. La referencia la
    // construye `referenciaParaWompi` a partir del ID de la transacción, así que
    // el dato está ahí y correlacionarlo es legítimo.
    const campos = camposDeCorrelacionWompi({
      event: 'transaction.updated',
      data: { transaction: { id: 'wompi-txn-12345', status: 'APPROVED', reference: REFERENCIA_SALEOR } },
    })

    expect(campos).toEqual({ pspReference: 'wompi-txn-12345', transactionId: REFERENCIA_SALEOR })
  })

  it('NO mapea a transactionId una referencia que no es un ID de transacción de Saleor', () => {
    // El cuerpo lo manda Wompi y puede traer una referencia ajena (cuenta de
    // comercio compartida, prueba manual en el panel). Etiquetarla como
    // `transactionId` daría una correlación falsa, que es peor que no tenerla:
    // un humano buscaría en Saleor un id que nunca existió.
    const campos = camposDeCorrelacionWompi({
      data: { transaction: { id: 'wompi-txn-12345', reference: 'referencia-de-otra-integracion' } },
    })

    expect(campos).toEqual({ pspReference: 'wompi-txn-12345' })
    expect('transactionId' in campos).toBe(false)
  })

  it('NO mapea a transactionId un base64 válido que decodifica a otro tipo de Saleor', () => {
    // `base64("Checkout:1")` decodifica limpiamente, así que un filtro que solo
    // mirara "¿es base64?" lo daría por bueno. Lo que se exige es el tipo relay
    // correcto, porque el id de un checkout NO resuelve en
    // `transactionEventReport`.
    const campos = camposDeCorrelacionWompi({
      data: { transaction: { id: 'wompi-txn-12345', reference: 'Q2hlY2tvdXQ6MQ==' } },
    })

    expect(campos).toEqual({ pspReference: 'wompi-txn-12345' })
  })

  it('una referencia real de 72 caracteres cabe holgadamente en el tope de longitud', () => {
    // El tope existe porque el cuerpo se lee antes de verificar la firma. Si
    // alguien lo bajara para "apretar" el filtro, la correlación del camino
    // feliz desaparecería en silencio: esto lo pone rojo antes.
    expect(REFERENCIA_SALEOR.length).toBe(72)
    expect(REFERENCIA_SALEOR.length).toBeLessThanOrEqual(LONGITUD_MAXIMA_VALOR)
  })

  it('descarta una referencia kilométrica sin llegar a decodificarla', () => {
    // El tope se aplica ANTES del base64: una referencia de megabytes no debe
    // convertirse en una decodificación de megabytes por cada evento entrante.
    const enorme = 'x'.repeat(LONGITUD_MAXIMA_VALOR + 1)

    expect(camposDeCorrelacionWompi({ data: { transaction: { id: 'wompi-txn-12345', reference: enorme } } })).toEqual({
      pspReference: 'wompi-txn-12345',
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['sin data', { event: 'transaction.updated' }],
    ['data null', { data: null }],
    ['sin transaction', { data: {} }],
    ['transaction sin id', { data: { transaction: { status: 'APPROVED' } } }],
    ['id no textual', { data: { transaction: { id: 999 } } }],
    ['reference no textual', { data: { transaction: { reference: 999 } } }],
    ['reference vacía', { data: { transaction: { reference: '' } } }],
    ['reference basura no base64', { data: { transaction: { reference: '@@@@@@' } } }],
    ['reference con solo el prefijo', { data: { transaction: { reference: 'VHJhbnNhY3Rpb25JdGVtOg==' } } }],
  ])('no lanza y devuelve {} con evento basura: %s', (_titulo, evento) => {
    expect(() => camposDeCorrelacionWompi(evento)).not.toThrow()
    expect(camposDeCorrelacionWompi(evento)).toEqual({})
  })
})
