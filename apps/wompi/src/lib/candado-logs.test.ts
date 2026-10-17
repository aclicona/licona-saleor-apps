import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * B-1369 — Candado ESTÁTICO de logs.
 *
 * `redact` de pino (ver `logging.ts`, RUTAS_REDACTADAS) es la red de ejecución:
 * censura por nombre de campo hasta un nivel de anidamiento. Este test es la capa
 * complementaria, en tiempo de revisión: ninguna llamada de log del código fuente
 * debe nombrar material sensible del webhook (cuerpo, cabeceras, firma, token,
 * email o datos de cliente), ni siquiera si `redact` lo cubriría.
 *
 * Qué se prohíbe DENTRO de los argumentos de `log.<nivel>(...)` (también `logger`,
 * `app.log`, `req.log`, `request.log`, `deps.log`, …):
 *  - `req.body` / `request.body`, el identificador o campo `rawBody`;
 *  - `req.headers` / `request.headers`;
 *  - el literal `saleor-signature` (en clave, cadena o plantilla);
 *  - claves de objeto `token`, `email` o que empiecen por `customer`.
 *
 * Si un log legítimo necesita algo así, se loguea un derivado (longitud, hash,
 * booleano), no el dato. Este archivo es el mismo en apps/wompi y apps/envios salvo la lista EXCEPCIONES.
 */

const NIVELES = new Set(['info', 'warn', 'error', 'debug', 'fatal', 'trace'])
const RECEPTOR_LOG = /(^|\.)(log|logger)$/
const CLAVE_PROHIBIDA = /^(token|email|customer.*)$/i
const CUERPO_O_CABECERAS = /^(req|request)\.(body|headers)$/

export interface Violacion {
  archivo: string
  linea: number
  patron: string
  /** Texto de las cadenas de la llamada de log (el mensaje), para identificarla sin número de línea. */
  mensaje: string
}

/**
 * Hallazgo que se tolera a propósito. Se identifica por archivo + patrón + un
 * fragmento del MENSAJE del log (no por número de línea, que se mueve al editar).
 */
export interface Excepcion {
  archivo: string
  patron: string
  fragmentoMensaje: string
  motivo: string
}

const MOTIVO_RAWBODY = 'B-1369: decisión pendiente de Andrés'

/**
 * Excepciones vigentes. Vacía desde B-1374: los cinco `rawBody` de wompi-incoming se
 * sustituyeron por `resumenPago` (sin PII), por decisión de Andrés. La lista no se pudre: una excepción que ya no corresponde
 * a ningún hallazgo real FALLA el test (bórrala cuando el log se corrija).
 * apps/envios lleva la lista vacía.
 */
export const EXCEPCIONES: readonly Excepcion[] = [
]

/** Cubre una violación esta excepción. */
function cubre(e: Excepcion, v: Violacion): boolean {
  return e.archivo === v.archivo && e.patron === v.patron && v.mensaje.includes(e.fragmentoMensaje)
}

/**
 * Separa los hallazgos en: no cubiertos (fallan) y excepciones sin hallazgo
 * (obsoletas, también fallan).
 */
export function evaluar(violaciones: readonly Violacion[], excepciones: readonly Excepcion[]) {
  return {
    nuevas: violaciones.filter((v) => !excepciones.some((e) => cubre(e, v))),
    obsoletas: excepciones.filter((e) => !violaciones.some((v) => cubre(e, v))),
  }
}

/** Texto de las cadenas de un nodo (excluye nombres de clave). */
function textoDeCadenas(nodo: ts.Node): string {
  const trozos: string[] = []
  const visitar = (n: ts.Node): void => {
    const esClave = n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n
    if (ts.isStringLiteralLike(n) && !esClave) trozos.push(n.text)
    ts.forEachChild(n, visitar)
  }
  visitar(nodo)
  return trozos.join('')
}

/** Nombre de una clave de objeto, o `undefined` si es computada. */
function nombreDeClave(nombre: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(nombre) || ts.isStringLiteral(nombre) || ts.isNoSubstitutionTemplateLiteral(nombre)) {
    return nombre.text
  }
  return undefined
}

/**
 * `req.headers['saleor-domain']`: lectura de UNA cabecera no secreta, no el objeto
 * entero. `authorization` y `saleor-signature` siguen prohibidas (la segunda la
 * atrapa la regla del literal; la primera, aquí).
 */
function esLecturaDeCabeceraInocua(nodo: ts.Node): boolean {
  const padre = nodo.parent
  if (!ts.isElementAccessExpression(padre) || padre.expression !== nodo) return false
  const clave = padre.argumentExpression
  return ts.isStringLiteralLike(clave) && clave.text.toLowerCase() !== 'authorization'
}

/** Patrón prohibido que representa este nodo, o `null`. */
function patronProhibido(nodo: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(nodo) && nodo.text === 'rawBody') return 'rawBody'
  if (ts.isPropertyAccessExpression(nodo)) {
    if (nodo.name.text === 'rawBody') return 'rawBody'
    if (CUERPO_O_CABECERAS.test(nodo.getText(sf)) && !esLecturaDeCabeceraInocua(nodo)) {
      return nodo.getText(sf)
    }
  }
  if (ts.isStringLiteralLike(nodo) || ts.isTemplateHead(nodo) || ts.isTemplateMiddle(nodo) || ts.isTemplateTail(nodo)) {
    if (/saleor-signature/i.test(nodo.text)) return 'saleor-signature'
  }
  if (ts.isPropertyAssignment(nodo) || ts.isShorthandPropertyAssignment(nodo)) {
    const clave = nombreDeClave(nodo.name)
    if (clave && /saleor-signature/i.test(clave)) return 'saleor-signature'
    if (clave && CLAVE_PROHIBIDA.test(clave)) return `clave "${clave}"`
  }
  return null
}

/** Es una llamada `<algo>.log.<nivel>(...)` / `logger.<nivel>(...)`. */
function esLlamadaDeLog(nodo: ts.Node, sf: ts.SourceFile): nodo is ts.CallExpression {
  if (!ts.isCallExpression(nodo) || !ts.isPropertyAccessExpression(nodo.expression)) return false
  const { expression: receptor, name } = nodo.expression
  return NIVELES.has(name.text) && RECEPTOR_LOG.test(receptor.getText(sf))
}

/** Busca material sensible en las llamadas de log de un fuente. */
export function violacionesEnFuente(codigo: string, archivo = 'memoria.ts'): Violacion[] {
  const sf = ts.createSourceFile(archivo, codigo, ts.ScriptTarget.Latest, true)
  const encontradas: Violacion[] = []
  let mensaje = ''
  const dentroDeLog = (nodo: ts.Node): void => {
    const patron = patronProhibido(nodo, sf)
    if (patron) {
      const { line } = sf.getLineAndCharacterOfPosition(nodo.getStart(sf))
      encontradas.push({ archivo, linea: line + 1, patron, mensaje })
    }
    ts.forEachChild(nodo, dentroDeLog)
  }
  const recorrer = (nodo: ts.Node): void => {
    if (esLlamadaDeLog(nodo, sf)) {
      mensaje = nodo.arguments.map(textoDeCadenas).join('')
      nodo.arguments.forEach(dentroDeLog)
    }
    ts.forEachChild(nodo, recorrer)
  }
  recorrer(sf)
  return encontradas
}

function fuentesDeProduccion(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) return fuentesDeProduccion(ruta)
    return ruta.endsWith('.ts') && !ruta.endsWith('.test.ts') ? [ruta] : []
  })
}

describe('candado estático de logs (B-1369)', () => {
  it.each([
    ["log.info({ rawBody }, 'x')", 'rawBody'],
    ["log.info({ payload: ctx.rawBody }, 'x')", 'rawBody'],
    ["req.log.info({ cuerpo: req.body }, 'x')", 'req.body'],
    ["log.error({ headers: req.headers }, 'x')", 'req.headers'],
    ["log.warn({ h: request.headers })", 'request.headers'],
    ["log.warn({ a: req.headers['authorization'] })", "req.headers"],
    ["log.warn({ a: req.headers['saleor-signature'] })", 'saleor-signature'],
    ["log.warn({ 'saleor-signature': firma }, 'x')", 'saleor-signature'],
    ["app.log.info('llegó saleor-signature ' + x)", 'saleor-signature'],
    ["logger.warn({ customerEmail: x }, 'x')", 'clave "customerEmail"'],
    ["log.info({ token })", 'clave "token"'],
    ["log.info({ a: { email: x } })", 'clave "email"'],
    [
      "log.error(\n  {\n    checkoutId,\n    token: t,\n  },\n  'multilínea',\n)",
      'clave "token"',
    ],
  ])('detecta: %s', (codigo, patron) => {
    const v = violacionesEnFuente(codigo)
    expect(v.map((x) => x.patron)).toContain(patron)
  })

  it('informa la línea de la violación', () => {
    const v = violacionesEnFuente("const a = 1\nlog.info({\n  token,\n}, 'x')")
    expect(v).toEqual([{ archivo: 'memoria.ts', linea: 3, patron: 'clave "token"', mensaje: 'x' }])
  })

  it.each([
    "log.info({ firmaMs, restanteMs }, 'Firma verificada')",
    "log.warn({ checkoutId, transactionId }, 'sin credenciales')",
    "app.log.info({ puerto }, 'escuchando')",
    "const t = { token: 1 }; guardar(rawBody, req.headers)",
    "req.log.error({ err }, 'falló')",
    "req.log.info({ dominio: req.headers['saleor-domain'] ?? null }, 'x')",
  ])('no marca: %s', (codigo) => {
    expect(violacionesEnFuente(codigo)).toEqual([])
  })

  it('el código fuente real no loguea material sensible del webhook', () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
    const archivos = fuentesDeProduccion(raiz)
    expect(archivos.length).toBeGreaterThan(0)
    const violaciones = archivos.flatMap((f) =>
      violacionesEnFuente(readFileSync(f, 'utf8'), relative(raiz, f)),
    )
    const { nuevas, obsoletas } = evaluar(violaciones, EXCEPCIONES)
    // Regla 1: un hallazgo fuera de la lista falla.
    expect(nuevas.map((v) => `${v.archivo}:${v.linea} -> ${v.patron}`)).toEqual([])
    // Regla 2: una excepción sin hallazgo real también (la lista no se pudre).
    expect(obsoletas.map((e) => `${e.archivo} [${e.fragmentoMensaje}] ya no corresponde a ningún log`)).toEqual([])
  })

  describe('lista de excepciones', () => {
    const codigo = "log.fatal({ rawBody }, 'Pago raro: revisar')"
    const excepcion: Excepcion = { archivo: 'a.ts', patron: 'rawBody', fragmentoMensaje: 'Pago raro', motivo: MOTIVO_RAWBODY }
    const v = violacionesEnFuente(codigo, 'a.ts')

    it('tolera un hallazgo cubierto por mensaje, sin depender de la línea', () => {
      const movido = violacionesEnFuente(`// a\n// b\n${codigo}`, 'a.ts')
      expect(evaluar(movido, [excepcion])).toEqual({ nuevas: [], obsoletas: [] })
    })

    it('un hallazgo nuevo fuera de la lista falla', () => {
      const otro = violacionesEnFuente("log.error({ rawBody }, 'Otro log')", 'a.ts')
      expect(evaluar([...v, ...otro], [excepcion]).nuevas).toHaveLength(1)
    })

    it('un mismo mensaje en otro archivo no queda cubierto', () => {
      expect(evaluar(violacionesEnFuente(codigo, 'b.ts'), [excepcion]).nuevas).toHaveLength(1)
    })

    it('una excepción que ya no corresponde a ningún hallazgo falla', () => {
      const limpio = violacionesEnFuente("log.fatal({ id }, 'Pago raro: revisar')", 'a.ts')
      expect(evaluar(limpio, [excepcion]).obsoletas).toEqual([excepcion])
    })

    it('toda excepción vigente lleva motivo con referencia', () => {
      for (const e of EXCEPCIONES) expect(e.motivo).toMatch(/^B-1369/)
    })
  })
})
