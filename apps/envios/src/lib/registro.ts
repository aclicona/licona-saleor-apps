import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * `POST /api/register` — Saleor entrega aquí el token tras instalar la App.
 *
 * Vivía en línea dentro de `index.ts` y **escribía el token entero en el log**
 * (`app.log.info({ msg: 'App registered — copy token to .env', token: auth_token })`),
 * con el pretexto de facilitar el desarrollo local. Un token en un log retenido
 * es una credencial válida a la vista de cualquiera con acceso de lectura al
 * panel de despliegue, y los logs de desarrollo acaban en el mismo agregador
 * que los de producción.
 *
 * Se registra el **evento** y el **origen** —que es lo que sirve para
 * diagnosticar ("¿me llegó el token?", "¿de qué Saleor?")— y la longitud, que
 * permite distinguir "llegó vacío" de "llegó" sin revelar el valor. Mismo
 * patrón, campo por campo, que `apps/wompi/src/lib/registro.ts`.
 *
 * Responder 200 no es opcional: si esta respuesta falla, Saleor borra la App
 * entera y revierte la instalación (fork: `saleor/app/installation_utils.py`
 * líneas 302-306, `app.delete()` en el `except`).
 *
 * Está en su propio módulo, y no en `index.ts`, porque `index.ts` llama a
 * `app.listen()` al importarse: en línea no había forma de probar qué escribe
 * en el log sin levantar un servidor.
 */
export async function manejadorRegistro(req: FastifyRequest, reply: FastifyReply) {
  const { auth_token } = (req.body ?? {}) as { auth_token?: string }
  if (!auth_token) return reply.status(400).send({ error: 'Missing auth_token' })

  req.log.info(
    {
      dominioSaleor: req.headers['saleor-domain'] ?? null,
      apiUrlSaleor: req.headers['saleor-api-url'] ?? null,
      longitudToken: auth_token.length,
    },
    'Saleor registró la App y entregó el token. El valor NO se escribe en el log: ' +
      'tomarlo del aprovisionamiento y ponerlo en SALEOR_APP_TOKEN',
  )

  return reply.status(200).send({ success: true })
}
