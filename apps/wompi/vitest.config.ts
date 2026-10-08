import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// B-1073: `@licona/webhook-utils` exporta `./dist` (compilado). Los tests lo
// resuelven desde `src` para no depender de que el dist exista ni esté al día:
// en un worktree limpio (o con el dist de otro checkout) un archivo de test
// podía no cargar sin que la suite lo avisara. El build de producción no cambia.
export default defineConfig({
  resolve: {
    alias: {
      '@licona/webhook-utils': fileURLToPath(
        new URL('../../packages/webhook-utils/src/index.ts', import.meta.url),
      ),
    },
  },
})
