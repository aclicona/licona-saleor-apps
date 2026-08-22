import type { FastifyReply, FastifyRequest } from 'fastify'
import { appRegistrada } from './config.js'

/**
 * Estado de registro de la App: arranque degradado y endpoints que lo respetan.
 *
 * El porqué de todo esto está en `config.ts` (sección "Dos clases de variable"):
 * `SALEOR_APP_TOKEN` solo existe DESPUÉS de instalar la App en Saleor, y la
 * instalación exige que la App ya esté viva. Aquí vive la consecuencia práctica
 * de esa decisión: qué se sirve sin token y qué se rechaza.
 */

/**
 * Mensaje del 503. Es explícito a propósito — nombra la variable exacta que
 * falta — porque quien lo va a leer está aprovisionando una instancia nueva y
 * necesita saber qué le falta, no que "algo salió mal".
 */
export const MENSAJE_NO_REGISTRADA = 'app no registrada: falta SALEOR_APP_TOKEN'

/**
 * `preHandler` de Fastify para los endpoints que necesitan hablar con Saleor.
 *
 * Se responde **503** (Service Unavailable) y no 500 ni 401 porque es lo que
 * literalmente ocurre: el servicio existe, la petición es válida, y la
 * indisponibilidad es **temporal y de configuración**. La diferencia importa
 * aguas arriba:
 *  - un 500 diría "bug de la App" y mandaría a alguien a leer un stack trace
 *    que no existe;
 *  - un 200 mentiría, y en el webhook entrante de Wompi eso es lo peor posible:
 *    Wompi daría el evento por entregado y **no reintentaría**, perdiendo para
 *    siempre la confirmación de un pago real;
 *  - un 503 es la señal estándar de "vuelve a intentarlo", que es exactamente
 *    lo que se quiere: en cuanto el token esté puesto, el reintento entra solo.
 *
 * No hace ninguna llamada de red: solo mira el entorno.
 */
export async function exigirAppRegistrada(req: FastifyRequest, reply: FastifyReply) {
  if (appRegistrada()) return

  req.log.error(
    { ruta: req.url, metodo: req.method },
    'Petición rechazada con 503: la App no está registrada en Saleor (falta SALEOR_APP_TOKEN). ' +
      'Instalar la App en el Dashboard, poner el token en el entorno y reiniciar',
  )
  return reply.status(503).send({ error: MENSAJE_NO_REGISTRADA })
}

/**
 * Healthcheck. Barato por contrato: sin llamadas de red, sin tocar Saleor ni
 * Wompi — solo lectura del entorno.
 *
 * Expone `registered` porque un healthcheck que solo dice "el proceso responde"
 * es capaz de ponerse verde sobre una App **incapaz de procesar un solo pago**.
 * Ese es justo el estado en el que queda una instancia recién aprovisionada, y
 * es un estado que hay que poder ver desde fuera.
 *
 * Devuelve **200 también en modo degradado**, a propósito: si el orquestador
 * matara el contenedor por estar sin registrar, la App nunca llegaría viva al
 * momento en que Saleor le hace POST del token — y se reabriría el candado que
 * todo esto viene a romper. Quien quiera alertar sobre "degradada" mira el
 * campo `registered`, no el código HTTP.
 */
export async function manejadorSalud() {
  const registered = appRegistrada()
  return { status: registered ? 'ok' : 'degraded', registered }
}

/**
 * `POST /api/register` — Saleor entrega aquí el token tras instalar la App.
 *
 * Responder 200 no es opcional: si esta respuesta falla, Saleor **borra la App
 * entera** y revierte la instalación (fork: `saleor/app/installation_utils.py`
 * líneas 302-306, `app.delete()` en el `except`).
 *
 * El token NO se escribe en el log. Se registra el *evento* de registro y el
 * origen, que es lo que sirve para diagnosticar ("¿me llegó el token?", "¿de
 * qué Saleor?") sin dejar una credencial válida en un log retenido, que puede
 * acabar en un agregador, en una copia de seguridad o a la vista de cualquiera
 * con acceso de lectura al panel de despliegue.
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
