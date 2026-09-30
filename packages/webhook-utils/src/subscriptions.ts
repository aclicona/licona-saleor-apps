import { buildSchema, parse, validate, type GraphQLError } from 'graphql'

/**
 * Validación de las `query` de suscripción del manifiesto contra un esquema.
 *
 * Las `query` son cadenas crudas: ni el typecheck ni ningún test las compila.
 * Si un sync del fork renombra o quita un campo, la query sigue siendo sintaxis
 * válida y el fallo es silencioso (Saleor entrega menos campos y la App lee
 * `undefined`, p. ej. un `action.amount` inexistente en el camino del dinero).
 * Esto las valida con `graphql.validate` — sin red, el esquema llega como SDL.
 */

export interface WebhookDeManifiesto {
  name: string
  query: string
}

export interface ErrorDeSubscription {
  webhook: string
  mensaje: string
}

export function validarSubscriptions(webhooks: WebhookDeManifiesto[], esquemaSdl: string): ErrorDeSubscription[] {
  const esquema = buildSchema(esquemaSdl)
  const errores: ErrorDeSubscription[] = []

  for (const w of webhooks) {
    let fallos: readonly GraphQLError[]
    try {
      fallos = validate(esquema, parse(w.query))
    } catch (err) {
      errores.push({ webhook: w.name, mensaje: `sintaxis inválida: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }
    for (const f of fallos) errores.push({ webhook: w.name, mensaje: f.message })
  }

  return errores
}
