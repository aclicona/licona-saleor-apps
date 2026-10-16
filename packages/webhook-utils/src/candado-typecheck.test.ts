import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * B-1364 — Candado del typecheck: compilar los paquetes de workspace ANTES de `tsc`.
 *
 * Los paquetes de `packages/*` (hoy `@licona/webhook-utils`) se consumen vía su
 * `dist/` (campos `main`/`types`/`exports`). Un `tsc --noEmit` que no reconstruye
 * antes el paquete se fía de un `dist` desfasado: da verde con tipos viejos o rojo
 * fantasma (modo de fallo de B-1061/B-1073/B-1087). B-1118 lo arregló anteponiendo
 * `pnpm --filter @licona/webhook-utils build &&` al `tsc` del script `typecheck`,
 * pero esa protección vivía solo en una cadena de package.json: bastaba con que
 * alguien la quitara, o con añadir un paquete nuevo, para volver al problema sin
 * que nada fallara.
 *
 * Este test lo ata:
 *  - cada app con dependencias de workspace hacia `packages/*` debe tener script
 *    `typecheck`, y el tramo ANTES del primer `tsc` debe construir esas dependencias;
 *  - lo mismo para cada paquete de `packages/*` que dependa de otro paquete;
 *  - el `typecheck` de la raíz debe construir TODOS los paquetes de `packages/*`.
 *
 * Cuentan como cobertura (solo si van antes del primer `tsc`): `pnpm --filter D build`
 * (o `--filter=D` / `-F D`), `pnpm --filter <propio>^... build` (dependencias del propio
 * paquete), `pnpm --filter "./packages/**" build` y `pnpm -r build` / `pnpm build` en la raíz.
 * Un build DESPUÉS de `tsc` no cubre nada.
 */

export interface ScriptContext {
  /** Nombre del paquete dueño del script (para `--filter <nombre>^...`). */
  ownName?: string
  /** `true` en la raíz: ahí `pnpm build` equivale a `pnpm -r build`. */
  isRoot?: boolean
}

const unquote = (token: string): string => token.replace(/^["']|["']$/g, '')

/** Tramo del script anterior al primer `tsc`; `null` si el script no invoca `tsc`. */
export function prefixBeforeTsc(script: string): string | null {
  const match = /(^|[\s&;|(])tsc(?=$|[\s&;|)])/.exec(script)
  if (!match) return null
  return script.slice(0, match.index)
}

/** Dependencias de `deps` que el tramo previo al primer `tsc` NO construye. */
export function uncoveredDeps(script: string, deps: string[], ctx: ScriptContext = {}): string[] {
  if (deps.length === 0) return []
  const prefix = prefixBeforeTsc(script)
  if (prefix === null) return [...deps]

  const covered = new Set<string>()
  for (const segment of prefix.split(/&&|;|\|\|/)) {
    const tokens = segment.trim().split(/\s+/).map(unquote).filter(Boolean)
    if (tokens[0] !== 'pnpm' || !tokens.includes('build')) continue
    const args = tokens.slice(1, tokens.indexOf('build'))
    const rest = tokens.slice(tokens.indexOf('build') + 1)
    // `pnpm build` y `pnpm -r build` sin filtro: solo la raíz construye todo el workspace.
    const hasFilter = [...args, ...rest].some((t) => /^(--filter|-F)(=|$)/.test(t))
    const recursive = args.some((t) => t === '-r' || t === '--recursive')
    if (!hasFilter && (recursive || ctx.isRoot)) {
      deps.forEach((d) => covered.add(d))
      continue
    }
    const all = [...args, ...rest]
    for (let i = 0; i < all.length; i++) {
      const t = all[i]
      let value: string | undefined
      if (t === '--filter' || t === '-F') value = all[i + 1]
      else if (t.startsWith('--filter=')) value = t.slice('--filter='.length)
      else if (t.startsWith('-F=')) value = t.slice('-F='.length)
      if (value === undefined) continue
      const selector = unquote(value).replace(/\.\.\.$/, '')
      if (selector.startsWith('./packages/')) deps.forEach((d) => covered.add(d))
      else if (ctx.ownName && selector === `${ctx.ownName}^`) deps.forEach((d) => covered.add(d))
      else covered.add(selector)
    }
  }
  return deps.filter((d) => !covered.has(d))
}

describe('uncoveredDeps (lógica pura)', () => {
  const W = '@licona/webhook-utils'
  const tabla: Array<[string, string, string[], ScriptContext, string[]]> = [
    ['filtro explícito antes de tsc', `pnpm --filter ${W} build && tsc --noEmit`, [W], {}, []],
    ['filtro con =', `pnpm --filter=${W} build && tsc --noEmit`, [W], {}, []],
    ['filtro corto -F', `pnpm -F ${W} build && tsc --noEmit`, [W], {}, []],
    ['filtro entrecomillado', `pnpm --filter "${W}" build && tsc --noEmit`, [W], {}, []],
    ['dependencias del propio paquete (^...)', 'pnpm --filter "app^..." build && tsc --noEmit', [W], { ownName: 'app' }, []],
    ['glob ./packages/**', 'pnpm --filter "./packages/**" build && tsc --noEmit', [W], {}, []],
    ['glob ./packages/*', 'pnpm --filter ./packages/* build && tsc --noEmit', [W], {}, []],
    ['pnpm -r build', 'pnpm -r build && tsc --noEmit', [W], {}, []],
    ['pnpm build en la raíz', 'pnpm build && pnpm -r exec tsc --noEmit', [W], { isRoot: true }, []],
    ['raíz real', `pnpm --filter ${W} build && pnpm -r exec tsc --noEmit`, [W], { isRoot: true }, []],
    ['sin dependencias no exige nada', 'tsc --noEmit', [], {}, []],
    ['ROJO: prefijo quitado', 'tsc --noEmit', [W], {}, [W]],
    ['ROJO: build después de tsc', `tsc --noEmit && pnpm --filter ${W} build`, [W], {}, [W]],
    ['ROJO: script sin tsc', `pnpm --filter ${W} build`, [W], {}, [W]],
    ['ROJO: filtro de otro paquete', 'pnpm --filter otro build && tsc --noEmit', [W], {}, [W]],
    ['ROJO: filtro sin build', `pnpm --filter ${W} test && tsc --noEmit`, [W], {}, [W]],
    ['ROJO: pnpm build fuera de la raíz', 'pnpm build && tsc --noEmit', [W], {}, [W]],
    ['ROJO: ^... de otro paquete', 'pnpm --filter "otra^..." build && tsc --noEmit', [W], { ownName: 'app' }, [W]],
    ['parcial: cubre una de dos', `pnpm --filter ${W} build && tsc --noEmit`, [W, 'nuevo'], {}, ['nuevo']],
  ]
  it.each(tabla)('%s', (_n, script, deps, ctx, esperado) => {
    expect(uncoveredDeps(script, deps, ctx)).toEqual(esperado)
  })
})

// ---------------------------------------------------------------------------
// Candado sobre el monorepo real
// ---------------------------------------------------------------------------

interface Manifest {
  dir: string
  file: string
  name: string
  scripts: Record<string, string>
  workspaceDeps: string[]
}

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function leer(dir: string): Manifest | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as {
    name?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const todas = { ...pkg.dependencies, ...pkg.devDependencies }
  return {
    dir,
    file: file.slice(RAIZ.length + 1),
    name: pkg.name ?? dir,
    scripts: pkg.scripts ?? {},
    workspaceDeps: Object.entries(todas)
      .filter(([, v]) => v.startsWith('workspace:'))
      .map(([k]) => k),
  }
}

function manifiestos(sub: string): Manifest[] {
  const base = join(RAIZ, sub)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => leer(join(base, e.name)))
    .filter((m): m is Manifest => m !== null)
}

const paquetes = manifiestos('packages')
const nombresPaquetes = new Set(paquetes.map((p) => p.name))
const apps = manifiestos('apps')
const raiz = leer(RAIZ)

function mensaje(m: Manifest, faltan: string[], donde: string): string {
  return (
    `B-1364: ${m.file} (${donde}) no construye antes de \`tsc\`: ${faltan.join(', ')}. ` +
    'Los paquetes de workspace se consumen vía dist/; sin reconstruirlos antes, `tsc --noEmit` ' +
    'se fía de un dist desfasado (B-1061/B-1073/B-1087). Antepón ' +
    faltan.map((f) => `\`pnpm --filter ${f} build\``).join(' && ') +
    ' al `tsc` del script `typecheck`.'
  )
}

describe('B-1364: el typecheck compila los paquetes de workspace antes de tsc', () => {
  it('la raíz y packages/ existen y se leen (el candado no se vuelve vacuo)', () => {
    expect(raiz).not.toBeNull()
    expect(nombresPaquetes.size).toBeGreaterThan(0)
  })

  it('el typecheck de la raíz construye TODOS los paquetes de packages/*', () => {
    const script = raiz?.scripts.typecheck
    expect(script, 'B-1364: el package.json raíz no tiene script `typecheck`').toBeTruthy()
    const faltan = uncoveredDeps(script!, [...nombresPaquetes], { isRoot: true })
    expect(faltan, mensaje(raiz!, faltan, 'typecheck raíz')).toEqual([])
  })

  describe.each(apps.map((a) => [a.name, a] as const))('app %s', (_n, app) => {
    const deps = app.workspaceDeps.filter((d) => nombresPaquetes.has(d))
    it('tiene script typecheck si depende de paquetes de workspace', () => {
      if (deps.length === 0) return
      expect(
        app.scripts.typecheck,
        `B-1364: ${app.file} depende de ${deps.join(', ')} (workspace) pero no tiene script \`typecheck\`; ` +
          'el typecheck de la raíz no basta para quien lo corra con `pnpm --filter`.',
      ).toBeTruthy()
    })
    it('su typecheck construye antes de tsc las dependencias de workspace', () => {
      if (deps.length === 0 || !app.scripts.typecheck) return
      const faltan = uncoveredDeps(app.scripts.typecheck, deps, { ownName: app.name })
      expect(faltan, mensaje(app, faltan, 'script typecheck')).toEqual([])
    })
  })

  describe.each(paquetes.map((p) => [p.name, p] as const))('paquete %s', (_n, pkg) => {
    const deps = pkg.workspaceDeps.filter((d) => nombresPaquetes.has(d))
    it('su typecheck construye antes de tsc los paquetes de los que depende', () => {
      if (deps.length === 0) return
      const script = pkg.scripts.typecheck
      expect(script, `B-1364: ${pkg.file} depende de ${deps.join(', ')} pero no tiene script \`typecheck\`.`).toBeTruthy()
      const faltan = uncoveredDeps(script, deps, { ownName: pkg.name })
      expect(faltan, mensaje(pkg, faltan, 'script typecheck')).toEqual([])
    })
  })
})
