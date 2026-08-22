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

  it('NO mapea data.transaction.reference a transactionId', () => {
    // `reference` lo rellena transaction-initialize con `idempotencyKey ?? id`,
    // así que puede no ser un id de transacción de Saleor. Etiquetarlo como tal
    // daría una correlación falsa, que es peor que no tenerla.
    const campos = camposDeCorrelacionWompi({
      data: { transaction: { id: 'wompi-txn-12345', reference: 'clave-de-idempotencia-del-storefront' } },
    })

    expect(campos).toEqual({ pspReference: 'wompi-txn-12345' })
    expect('transactionId' in campos).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['sin data', { event: 'transaction.updated' }],
    ['data null', { data: null }],
    ['sin transaction', { data: {} }],
    ['transaction sin id', { data: { transaction: { status: 'APPROVED' } } }],
    ['id no textual', { data: { transaction: { id: 999 } } }],
  ])('no lanza y devuelve {} con evento basura: %s', (_titulo, evento) => {
    expect(() => camposDeCorrelacionWompi(evento)).not.toThrow()
    expect(camposDeCorrelacionWompi(evento)).toEqual({})
  })
})
