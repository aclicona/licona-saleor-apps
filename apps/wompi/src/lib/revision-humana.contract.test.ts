import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * B-1090 — contrato de logging: todo aviso para humanos lleva el literal «revisión humana».
 *
 * Railway aplana el JSON de pino y pone `level: "info"` a todo, así que no se puede filtrar por nivel.
 * El vigilante `scripts/railway-seguro/revision_humana_wompi.py` (repo raíz de ecommerce, corre al apagar
 * licona-store) marca como hallazgo toda línea cuyo `message` contiene «revisión humana». Un aviso humano
 * sin ese literal es invisible. Ver docs/conciliacion.md → «Quién lee los “requiere revisión humana”».
 */

const MARCADOR = /revisi[oó]n humana/i
const TRANSITORIO = /La próxima corrida reintenta/
const VENTANA_MENSAJE = 600

const leer = (ruta: string): string => readFileSync(new URL(ruta, import.meta.url), 'utf8')

const ARCHIVOS_CONCILIACION = [
  '../lib/conciliacion.ts',
  '../lib/conciliacion-solicitudes.ts',
  '../lib/conciliacion-periodica.ts',
]
const ARCHIVOS_CON_FATAL = [...ARCHIVOS_CONCILIACION, '../lib/decision-reembolso.ts', '../webhooks/wompi-incoming.ts']

/**
 * Llamadas de log y su mensaje: los ~600 caracteres siguientes, cortados en la siguiente llamada de log
 * (si no, el marcador de un aviso vecino taparía a uno que no lo lleva).
 */
function ventanas(fuente: string, patron: RegExp): { linea: number; texto: string }[] {
  const inicios = [...fuente.matchAll(/log\.(?:fatal|error|warn|info)\(|registrar\.call\(log,/g)].map((m) => m.index ?? 0)
  const salida: { linea: number; texto: string }[] = []
  for (const m of fuente.matchAll(patron)) {
    const idx = m.index ?? 0
    const siguiente = inicios.find((i) => i > idx) ?? Infinity
    salida.push({
      linea: fuente.slice(0, idx).split('\n').length,
      texto: fuente.slice(idx, Math.min(idx + VENTANA_MENSAJE, siguiente)),
    })
  }
  return salida
}

const MENSAJE_FALLO = (archivo: string, linea: number) =>
  `${archivo}:${linea}: un aviso humano sin el marcador "revisión humana" es invisible para revision_humana_wompi.py (B-1090)`

// log.error legítimamente ni humano ni transitorio: se listan por fragmento del mensaje, con el porqué.
const EXCEPCIONES_ERROR: { fragmento: string; porque: string }[] = [
  // La excepción inesperada de una corrida: el scheduler se re-arma solo y la siguiente corrida reintenta.
  { fragmento: 'la corrida lanzó una excepción; se re-arma igual', porque: 'transitorio: el temporizador se re-arma' },
]

describe('B-1090: avisos para humanos llevan «revisión humana»', () => {
  it.each(ARCHIVOS_CON_FATAL)('todo log.fatal / registrar.call(log, …) de %s lleva el marcador', (archivo) => {
    let fuente: string
    try {
      fuente = leer(archivo)
    } catch {
      return // archivo inexistente: nada que exigir
    }
    const llamadas = ventanas(fuente, /log\.fatal\(|registrar\.call\(log,/g)
    for (const { linea, texto } of llamadas) {
      expect(MARCADOR.test(texto), MENSAJE_FALLO(archivo, linea)).toBe(true)
    }
  })

  it.each(ARCHIVOS_CONCILIACION)('todo log.error de %s es humano, transitorio o excepción explícita', (archivo) => {
    const fuente = leer(archivo)
    for (const { linea, texto } of ventanas(fuente, /log\.error\(/g)) {
      const esExcepcion = EXCEPCIONES_ERROR.some((e) => texto.includes(e.fragmento))
      expect(MARCADOR.test(texto) || TRANSITORIO.test(texto) || esExcepcion, MENSAJE_FALLO(archivo, linea)).toBe(true)
    }
  })

  it('el contrato ve las llamadas (no pasa en vacío)', () => {
    const total = ARCHIVOS_CON_FATAL.flatMap((a) => {
      try {
        return ventanas(leer(a), /log\.fatal\(|registrar\.call\(log,|log\.error\(/g)
      } catch {
        return []
      }
    })
    expect(total.length).toBeGreaterThanOrEqual(10)
  })
})
