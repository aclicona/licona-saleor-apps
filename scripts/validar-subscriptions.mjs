// Valida las `query` de suscripción de los manifiestos de las Apps contra el
// esquema GraphQL del fork de Saleor (B-382). Requiere `pnpm -r build` antes.
//
// El esquema vive en el repo del fork, no aquí: se pasa por SALEOR_SCHEMA_PATH.
// Sin la variable el script se omite con aviso (exit 0); con `--requerido`
// su ausencia es un error, para activarlo en CI cuando el esquema esté disponible.
import { readFileSync, existsSync } from 'node:fs'
import { validarSubscriptions } from '../packages/webhook-utils/dist/index.js'

const ruta = process.env.SALEOR_SCHEMA_PATH
const requerido = process.argv.includes('--requerido')

if (!ruta) {
  console.log('validar-subscriptions: SALEOR_SCHEMA_PATH no definida — omitido')
  process.exit(requerido ? 1 : 0)
}
if (!existsSync(ruta)) {
  console.error(`validar-subscriptions: no existe el esquema en ${ruta}`)
  process.exit(1)
}

const esquema = readFileSync(ruta, 'utf8')
let fallos = 0

for (const app of ['wompi', 'envios']) {
  const { construirManifiesto } = await import(new URL(`../apps/${app}/dist/manifest.js`, import.meta.url))
  const webhooks = construirManifiesto('http://localhost').webhooks
  const errores = validarSubscriptions(webhooks, esquema)
  console.log(`${app}: ${webhooks.length} subscriptions, ${errores.length} con errores`)
  for (const e of errores) console.error(`  [${app}] ${e.webhook}: ${e.mensaje}`)
  fallos += errores.length
}

process.exit(fallos === 0 ? 0 : 1)
