// Configuración de ESLint del monorepo de Saleor Apps.
// DESTINO: <saleor-apps>/eslint.config.mjs
//
// Criterio de esta pasada: el linter atrapa BUGS, no reformatea. No hay ni una
// regla de comillas, comas finales o ancho de línea: inundarían la salida y
// esconderían lo que de verdad importa.
//
// Por qué ESLint y no Biome, pese a que Biome es más rápido y trae formateo:
// la regla de más valor para este código es `no-floating-promises`. Estas apps
// son webhooks de pago; una promesa sin `await` es un cobro o un reembolso que
// se pierde en silencio, sin excepción ni log. Esa regla necesita información
// de tipos. En Biome 2.5 `noFloatingPromises` sigue en el grupo `nursery`
// ("experimental y el comportamiento puede cambiar en cualquier momento") y
// depende de un motor de inferencia de tipos también experimental. En
// typescript-eslint es estable. No se apoya el control más caro del repo
// sobre algo marcado como experimental.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Exclusiones. Sin esto el linter cuenta ruido ajeno.
    ignores: [
      // Los worktrees viven DENTRO del repo: sin excluirlos, el linter
      // recorrería una copia entera del árbol y duplicaría cada hallazgo.
      '.worktrees/**',
      // Artefactos de compilación y dependencias.
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
    ],
  },

  js.configs.recommended,

  {
    // `no-undef` se apaga en TypeScript: el compilador ya lo cubre, y si no,
    // reportaría cada global de Node (`process`, `console`, `Buffer`) como
    // indefinido. Ese hueco lo cubre `pnpm typecheck`.
    name: 'licona/ts-base',
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off', // la reemplaza la versión de typescript-eslint
    },
  },

  {
    // Reglas con información de tipos: sólo sobre el código fuente real de
    // los tres paquetes. `projectService` resuelve el tsconfig de cada uno.
    name: 'licona/correccion-tipada',
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Async: el bloque que justifica la elección de herramienta ------
      // Promesa creada y nunca esperada ni encadenada. En un webhook de pago
      // esto es dinero que se mueve sin que nadie observe el resultado.
      '@typescript-eslint/no-floating-promises': 'error',
      // Promesa pasada donde se espera un valor sincrónico (p.ej. un `if`
      // sobre una promesa, siempre truthy), o un handler async cuyo rechazo
      // nadie recoge.
      '@typescript-eslint/no-misused-promises': 'error',
      // `await` sobre algo que no es thenable: casi siempre un await que
      // sobra o, peor, un await que falta más adentro.
      '@typescript-eslint/await-thenable': 'error',
      // `async` sin ningún `await`: promete asincronía que no hay.
      '@typescript-eslint/require-await': 'warn',

      // --- Variables e imports muertos -----------------------------------
      '@typescript-eslint/no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },

  {
    // Reglas sin información de tipos: aplican a todo el TS del repo.
    name: 'licona/correccion',
    files: ['**/*.ts'],
    rules: {
      // --- Errores silenciados -------------------------------------------
      // Un `catch {}` vacío se traga el fallo sin dejar rastro.
      'no-empty': ['warn', { allowEmptyCatch: false }],

      // --- Comparaciones sospechosas -------------------------------------
      // `==` sólo contra null (idioma `x == null` para null|undefined).
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-self-compare': 'warn',
      'valid-typeof': 'error',
      'use-isnan': 'error',
      'no-constant-binary-expression': 'error',
      'no-unsafe-negation': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'warn',
      'no-fallthrough': 'warn',

      // --- Async sin tipos -----------------------------------------------
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'warn',
    },
  },

  {
    // Los tests usan los globals de vitest.
    name: 'licona/tests',
    files: ['**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
)
