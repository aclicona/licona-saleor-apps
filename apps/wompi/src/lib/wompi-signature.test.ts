import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { construirCadenaAFirmar, verificarFirmaWompi, type EventoFirmado } from './wompi-signature.js'

/**
 * Tests del algoritmo de firma de eventos de Wompi
 * (https://docs.wompi.co/en/docs/colombia/eventos/).
 *
 * SHA-256 (no HMAC) sobre la concatenación sin separadores de:
 *   valores de `signature.properties` (en su orden) + `timestamp` (RAÍZ del evento) + secreto.
 */

const SECRET = 'test_events_secreto'

/** Calcula el checksum esperado a partir de la cadena literal. */
function sha256Hex(cadena: string): string {
  return createHash('sha256').update(cadena).digest('hex')
}

/** Evento de referencia con la forma real que envía Wompi. */
function evento(overrides: Partial<{ id: string; status: string; amount_in_cents: number }> = {}): EventoFirmado {
  return {
    data: {
      transaction: {
        id: 'wompi-txn-12345',
        status: 'APPROVED',
        reference: 'VHJhbnNhY3Rpb246YWJj',
        amount_in_cents: 12_000_000,
        ...overrides,
      },
    },
    timestamp: 1_700_000_000,
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
    },
  } as EventoFirmado
}

/** Cadena que corresponde al evento de referencia sin overrides. */
const CADENA_REFERENCIA = 'wompi-txn-12345APPROVED120000001700000000test_events_secreto'

describe('verificarFirmaWompi — evento REAL de Wompi (B-431)', () => {
  const SECRETO_EVENTOS = 'test_events_ficticio_b431'

  /** Forma exacta del primer evento real recibido el 2026-10-06: timestamp en la RAÍZ. */
  function eventoReal(): Record<string, unknown> {
    return {
      event: 'transaction.updated',
      data: {
        transaction: {
          id: '12084641-1791294667-72838',
          created_at: '2026-10-06T13:51:07.668Z',
          amount_in_cents: 1_800_000,
          reference: 'VHJhbnNhY3Rpb25JdGVtOmIxYzkzNThl',
          currency: 'COP',
          payment_method_type: 'CARD',
          payment_method: { type: 'CARD', extra: { brand: 'VISA', last_four: '4242' }, installments: 1 },
          status: 'APPROVED',
          status_message: null,
        },
      },
      sent_at: '2026-10-06T13:51:14.234Z',
      timestamp: 1_791_294_674,
      signature: {
        checksum: '',
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      },
      environment: 'test',
    }
  }

  const CADENA_REAL = '12084641-1791294667-72838APPROVED18000001791294674' + SECRETO_EVENTOS

  function firmado(mutar?: (e: Record<string, any>) => void): EventoFirmado {
    const e = eventoReal() as Record<string, any>
    e.signature.checksum = sha256Hex(CADENA_REAL)
    mutar?.(e)
    return e as EventoFirmado
  }

  it('acepta el evento con el timestamp en la raíz y checksum calculado según la doc', () => {
    expect(construirCadenaAFirmar(firmado(), SECRETO_EVENTOS)).toBe(CADENA_REAL)
    expect(verificarFirmaWompi(firmado(), undefined, SECRETO_EVENTOS)).toEqual({ valido: true })
  })

  it('rechaza el checksum alterado', () => {
    const e = firmado((x) => {
      x.signature.checksum = 'f'.repeat(64)
    })
    expect(verificarFirmaWompi(e, undefined, SECRETO_EVENTOS)).toMatchObject({ motivo: 'CHECKSUM_NO_COINCIDE' })
  })

  it('rechaza si cambia el timestamp raíz respecto del firmado', () => {
    const e = firmado((x) => {
      x.timestamp = 1_791_294_675
    })
    expect(verificarFirmaWompi(e, undefined, SECRETO_EVENTOS)).toMatchObject({ motivo: 'CHECKSUM_NO_COINCIDE' })
  })

  it('NO acepta la forma inventada: timestamp solo dentro de signature', () => {
    const e = firmado((x) => {
      x.signature.timestamp = x.timestamp
      delete x.timestamp
    })
    expect(verificarFirmaWompi(e, undefined, SECRETO_EVENTOS)).toMatchObject({ motivo: 'TIMESTAMP_INVALIDO' })
  })

  it('resuelve las propiedades en el orden que el evento indica', () => {
    const e = firmado((x) => {
      x.signature.properties = ['transaction.amount_in_cents', 'transaction.id']
      x.signature.checksum = sha256Hex('180000012084641-1791294667-728381791294674' + SECRETO_EVENTOS)
    })
    expect(verificarFirmaWompi(e, undefined, SECRETO_EVENTOS)).toEqual({ valido: true })
  })

  it('resuelve una propiedad anidada del evento real', () => {
    const e = firmado((x) => {
      x.signature.properties = ['transaction.payment_method.extra.last_four']
      x.signature.checksum = sha256Hex('42421791294674' + SECRETO_EVENTOS)
    })
    expect(verificarFirmaWompi(e, undefined, SECRETO_EVENTOS)).toEqual({ valido: true })
  })
})

describe('construirCadenaAFirmar — vector de la documentación de Wompi', () => {
  it('reproduce LITERALMENTE la cadena del ejemplo publicado por Wompi', () => {
    // Ejemplo textual de la doc: id, status, monto en centavos, timestamp y secreto,
    // concatenados sin ningún separador.
    const eventoDoc: EventoFirmado = {
      data: {
        transaction: {
          id: '1234-1610641025-49201',
          status: 'APPROVED',
          amount_in_cents: 4_490_000,
        },
      },
      timestamp: 1_530_291_411,
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      },
    } as EventoFirmado

    const cadena = construirCadenaAFirmar(eventoDoc, 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z')

    expect(cadena).toBe(
      '1234-1610641025-49201APPROVED44900001530291411prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z',
    )
  })

  it('acepta el evento del ejemplo cuando el checksum es el SHA-256 de esa cadena', () => {
    // OJO: el checksum que la doc imprime junto a ese ejemplo
    // (3476DDA5…8BD0) NO es el SHA-256 de la cadena que la propia doc imprime
    // — es un valor de adorno. Por eso el esperado se CALCULA aquí a partir de
    // la cadena documentada en vez de copiarse de la página.
    const secreto = 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z'
    const eventoDoc: EventoFirmado = {
      data: {
        transaction: { id: '1234-1610641025-49201', status: 'APPROVED', amount_in_cents: 4_490_000 },
      },
      timestamp: 1_530_291_411,
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
        checksum: sha256Hex(
          '1234-1610641025-49201APPROVED44900001530291411prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z',
        ).toUpperCase(),
      },
    } as EventoFirmado

    expect(verificarFirmaWompi(eventoDoc, undefined, secreto)).toEqual({ valido: true })
  })

  it('usa SHA-256 simple y no HMAC: el digest esperado es hash(cadena), sin clave', () => {
    // Guarda explícita contra la regresión que motivó este módulo. Si alguien
    // vuelve a meter createHmac, este test cae.
    const e = evento()
    ;(e.signature as { checksum?: string }).checksum = sha256Hex(CADENA_REFERENCIA)

    expect(verificarFirmaWompi(e, undefined, SECRET)).toEqual({ valido: true })
  })
})

describe('verificarFirmaWompi — camino válido', () => {
  it('acepta un evento firmado correctamente', () => {
    const e = evento()
    const checksum = sha256Hex(construirCadenaAFirmar(e, SECRET)!)

    expect(verificarFirmaWompi(e, checksum, SECRET)).toEqual({ valido: true })
  })

  it('acepta el checksum por la cabecera X-Event-Checksum', () => {
    expect(verificarFirmaWompi(evento(), sha256Hex(CADENA_REFERENCIA), SECRET)).toEqual({ valido: true })
  })

  it('acepta el checksum por signature.checksum del cuerpo', () => {
    const e = evento()
    ;(e.signature as { checksum?: string }).checksum = sha256Hex(CADENA_REFERENCIA)

    expect(verificarFirmaWompi(e, undefined, SECRET)).toEqual({ valido: true })
  })

  it('acepta el mismo checksum por cabecera Y cuerpo a la vez, como lo envía Wompi', () => {
    const checksum = sha256Hex(CADENA_REFERENCIA)
    const e = evento()
    ;(e.signature as { checksum?: string }).checksum = checksum

    expect(verificarFirmaWompi(e, checksum, SECRET)).toEqual({ valido: true })
  })

  it('compara el hex sin depender de mayúsculas/minúsculas', () => {
    // Wompi publica el checksum en MAYÚSCULAS; `digest("hex")` lo produce en
    // minúsculas. Ambas formas designan los mismos bytes.
    const enMinusculas = sha256Hex(CADENA_REFERENCIA)

    expect(verificarFirmaWompi(evento(), enMinusculas.toUpperCase(), SECRET)).toEqual({ valido: true })
    expect(verificarFirmaWompi(evento(), enMinusculas.toLowerCase(), SECRET)).toEqual({ valido: true })

    // Y también mezclado, para que no se cuele una comparación por prefijo.
    const mezclado = enMinusculas
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join('')
    expect(verificarFirmaWompi(evento(), mezclado, SECRET)).toEqual({ valido: true })
  })
})

describe('verificarFirmaWompi — manipulación del evento', () => {
  it('rechaza si se cambia el IMPORTE manteniendo el checksum', () => {
    // El escenario que importa: reenviar un evento real con el monto inflado.
    const checksumLegitimo = sha256Hex(CADENA_REFERENCIA)
    const manipulado = evento({ amount_in_cents: 1 })

    const resultado = verificarFirmaWompi(manipulado, checksumLegitimo, SECRET)

    expect(resultado.valido).toBe(false)
    expect(resultado).toMatchObject({ motivo: 'CHECKSUM_NO_COINCIDE' })
  })

  it('rechaza si se cambia el STATUS de DECLINED a APPROVED', () => {
    const declinada = evento({ status: 'DECLINED' })
    const checksumDeLaDeclinada = sha256Hex(construirCadenaAFirmar(declinada, SECRET)!)

    const aprobadaAlaFuerza = evento({ status: 'APPROVED' })

    expect(verificarFirmaWompi(aprobadaAlaFuerza, checksumDeLaDeclinada, SECRET)).toMatchObject({
      valido: false,
      motivo: 'CHECKSUM_NO_COINCIDE',
    })
  })

  it('rechaza si se cambia el id de la transacción', () => {
    expect(verificarFirmaWompi(evento({ id: 'otro-id' }), sha256Hex(CADENA_REFERENCIA), SECRET)).toMatchObject({
      valido: false,
      motivo: 'CHECKSUM_NO_COINCIDE',
    })
  })

  it('rechaza un checksum calculado con el secreto equivocado', () => {
    const conOtroSecreto = sha256Hex(construirCadenaAFirmar(evento(), 'secreto-del-atacante')!)

    expect(verificarFirmaWompi(evento(), conOtroSecreto, SECRET)).toMatchObject({
      valido: false,
      motivo: 'CHECKSUM_NO_COINCIDE',
    })
  })

  it('rechaza si se manipula el timestamp firmado', () => {
    const checksumLegitimo = sha256Hex(CADENA_REFERENCIA)
    const e = evento()
    ;(e as { timestamp: number }).timestamp = 1_799_999_999

    expect(verificarFirmaWompi(e, checksumLegitimo, SECRET)).toMatchObject({
      valido: false,
      motivo: 'CHECKSUM_NO_COINCIDE',
    })
  })

  it('rechaza si el checksum de la cabecera y el del cuerpo no coinciden entre sí', () => {
    // Dos copias redundantes del mismo valor; que difieran solo puede
    // significar que alguien tocó una. Aceptar "que cuadre alguna de las dos"
    // convertiría las dos copias en dos intentos.
    const valido = sha256Hex(CADENA_REFERENCIA)
    const e = evento()
    ;(e.signature as { checksum?: string }).checksum = 'F'.repeat(64)

    expect(verificarFirmaWompi(e, valido, SECRET)).toMatchObject({
      valido: false,
      motivo: 'CHECKSUM_INCONSISTENTE',
    })
  })
})

describe('verificarFirmaWompi — signature.properties variable (no está codificado fijo)', () => {
  it('respeta un ORDEN distinto de properties y sigue validando', () => {
    // La doc avisa de que la lista puede variar entre eventos. Si el orden
    // estuviera codificado fijo, este evento se rechazaría.
    const e = evento()
    ;(e.signature as { properties: string[] }).properties = [
      'transaction.amount_in_cents',
      'transaction.id',
      'transaction.status',
    ]

    const cadena = construirCadenaAFirmar(e, SECRET)
    expect(cadena).toBe('12000000wompi-txn-12345APPROVED1700000000test_events_secreto')
    expect(verificarFirmaWompi(e, sha256Hex(cadena!), SECRET)).toEqual({ valido: true })
  })

  it('valida un evento que firma propiedades DISTINTAS de las de una transacción', () => {
    const e: EventoFirmado = {
      data: { nequi: { status: 'APPROVED', token: 'tok-abc' } },
      timestamp: 1_700_000_000, signature: { properties: ['nequi.token', 'nequi.status'] },
    } as EventoFirmado

    const cadena = construirCadenaAFirmar(e, SECRET)
    expect(cadena).toBe('tok-abcAPPROVED1700000000test_events_secreto')
    expect(verificarFirmaWompi(e, sha256Hex(cadena!), SECRET)).toEqual({ valido: true })
  })

  it('resuelve rutas anidadas de más de dos niveles', () => {
    const e: EventoFirmado = {
      data: { transaction: { payment_method: { extra: { bank_name: 'Bancolombia' } } } },
      timestamp: 42, signature: { properties: ['transaction.payment_method.extra.bank_name'] },
    } as EventoFirmado

    expect(construirCadenaAFirmar(e, SECRET)).toBe('Bancolombia42test_events_secreto')
  })

  it('firma una sola propiedad cuando el evento solo lista una', () => {
    const e: EventoFirmado = {
      data: { transaction: { status: 'VOIDED' } },
      timestamp: 7, signature: { properties: ['transaction.status'] },
    } as EventoFirmado

    expect(construirCadenaAFirmar(e, SECRET)).toBe('VOIDED7test_events_secreto')
  })
})

describe('verificarFirmaWompi — casos degenerados (todos rechazan)', () => {
  const checksumCualquiera = sha256Hex(CADENA_REFERENCIA)

  it('rechaza si falta el bloque signature entero', () => {
    const e = { data: evento().data } as EventoFirmado

    expect(verificarFirmaWompi(e, checksumCualquiera, SECRET)).toMatchObject({
      valido: false,
      motivo: 'SIN_BLOQUE_SIGNATURE',
    })
  })

  it('rechaza un cuerpo nulo o vacío (POST anónimo)', () => {
    expect(verificarFirmaWompi(null, checksumCualquiera, SECRET)).toMatchObject({ motivo: 'SIN_BLOQUE_SIGNATURE' })
    expect(verificarFirmaWompi(undefined, checksumCualquiera, SECRET)).toMatchObject({ motivo: 'SIN_BLOQUE_SIGNATURE' })
    expect(verificarFirmaWompi({} as EventoFirmado, checksumCualquiera, SECRET)).toMatchObject({
      motivo: 'SIN_BLOQUE_SIGNATURE',
    })
  })

  it('rechaza si properties está VACÍO', () => {
    // Con la lista vacía la cadena sería solo timestamp+secreto: un checksum
    // válido para un evento serviría para cualquier otro cuerpo con el mismo
    // timestamp. Es una firma que no firma nada.
    const e = evento()
    ;(e.signature as { properties: string[] }).properties = []
    const cadenaSinDatos = sha256Hex('1700000000' + SECRET)

    expect(verificarFirmaWompi(e, cadenaSinDatos, SECRET)).toMatchObject({
      valido: false,
      motivo: 'PROPERTIES_VACIO',
    })
  })

  it('rechaza si properties no es un array', () => {
    const e = evento()
    ;(e.signature as { properties: unknown }).properties = 'transaction.id'

    expect(verificarFirmaWompi(e, checksumCualquiera, SECRET)).toMatchObject({
      valido: false,
      motivo: 'PROPERTIES_INVALIDO',
    })
  })

  it('rechaza si una propiedad listada NO existe en data', () => {
    // Tratarla como cadena vacía dejaría a un atacante borrar amount_in_cents
    // del evento y seguir produciendo un checksum válido.
    const e = evento()
    ;(e.signature as { properties: string[] }).properties = ['transaction.id', 'transaction.campo_inexistente']

    expect(verificarFirmaWompi(e, checksumCualquiera, SECRET)).toMatchObject({
      valido: false,
      motivo: 'PROPIEDAD_IRRESOLUBLE',
    })
  })

  it('rechaza si una propiedad listada resuelve a null o a un objeto', () => {
    const conNull = {
      data: { transaction: { id: null } },
      timestamp: 1, signature: { properties: ['transaction.id'] },
    } as unknown as EventoFirmado
    const conObjeto = {
      data: { transaction: { id: { anidado: 1 } } },
      timestamp: 1, signature: { properties: ['transaction.id'] },
    } as unknown as EventoFirmado

    expect(verificarFirmaWompi(conNull, checksumCualquiera, SECRET)).toMatchObject({ motivo: 'PROPIEDAD_IRRESOLUBLE' })
    expect(verificarFirmaWompi(conObjeto, checksumCualquiera, SECRET)).toMatchObject({ motivo: 'PROPIEDAD_IRRESOLUBLE' })
  })

  it('rechaza rutas que intentan escapar por la cadena de prototipos', () => {
    const e = evento()
    ;(e.signature as { properties: string[] }).properties = ['constructor.name']

    expect(verificarFirmaWompi(e, checksumCualquiera, SECRET)).toMatchObject({
      valido: false,
      motivo: 'PROPIEDAD_IRRESOLUBLE',
    })
  })

  it('rechaza si falta el checksum en la cabecera Y en el cuerpo', () => {
    expect(verificarFirmaWompi(evento(), undefined, SECRET)).toMatchObject({
      valido: false,
      motivo: 'CHECKSUM_AUSENTE',
    })
    expect(verificarFirmaWompi(evento(), '', SECRET)).toMatchObject({ motivo: 'CHECKSUM_AUSENTE' })
    expect(verificarFirmaWompi(evento(), '   ', SECRET)).toMatchObject({ motivo: 'CHECKSUM_AUSENTE' })
  })

  it('rechaza sin lanzar un checksum hex malformado', () => {
    // Buffer.from(x, "hex") trunca en silencio ante un carácter no hex, así que
    // sin validar el formato esto llegaría a timingSafeEqual y lanzaría.
    for (const malformado of ['no-es-hex', 'ZZ'.repeat(32), 'ab!cd', 'abc', 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() => verificarFirmaWompi(evento(), malformado, SECRET)).not.toThrow()
      expect(verificarFirmaWompi(evento(), malformado, SECRET)).toMatchObject({
        valido: false,
        motivo: 'CHECKSUM_MALFORMADO',
      })
    }
  })

  it('rechaza si falta el timestamp', () => {
    const e = evento()
    delete (e as { timestamp?: number }).timestamp

    expect(verificarFirmaWompi(e, checksumCualquiera, SECRET)).toMatchObject({
      valido: false,
      motivo: 'TIMESTAMP_INVALIDO',
    })
  })

  it('rechaza un timestamp que no es un entero UNIX', () => {
    for (const malo of [1.5, -1, NaN, Infinity, 'ayer', '17e9', {}, null]) {
      const e = evento()
      ;(e as { timestamp: unknown }).timestamp = malo
      expect(verificarFirmaWompi(e, checksumCualquiera, SECRET)).toMatchObject({ motivo: 'TIMESTAMP_INVALIDO' })
    }
  })

  it('acepta el timestamp en su forma de cadena de dígitos', () => {
    // Misma representación textual, así que aceptarlo no relaja nada.
    const e = evento()
    ;(e as { timestamp: unknown }).timestamp = '1700000000'

    expect(verificarFirmaWompi(e, sha256Hex(CADENA_REFERENCIA), SECRET)).toEqual({ valido: true })
  })

  it('rechaza si el secreto está vacío, aunque el evento esté bien formado', () => {
    // El fail-fast del arranque ya impide llegar aquí; que sea por diseño y no
    // por accidente criptográfico.
    expect(verificarFirmaWompi(evento(), checksumCualquiera, '')).toMatchObject({
      valido: false,
      motivo: 'SECRETO_AUSENTE',
    })
  })
})
