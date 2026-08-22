/**
 * Validación de configuración al arranque — fail-fast.
 *
 * Regla de negocio: este proyecto es un producto **single-tenant replicable**;
 * cada cliente es un despliegue nuevo. En ese modelo el fallo *normal* no es
 * "alguien borró una variable en producción", es "el aprovisionamiento de la
 * instancia nueva no puso todas las variables". Ese fallo tiene que ser un
 * deploy ROJO, no una App que levanta y empieza a cobrar mal.
 *
 * El caso que motiva esto: `WOMPI_EVENTS_SECRET`. El handler del webhook
 * entrante verificaba la firma solo `if (secret && ...)`, así que sin esa
 * variable la App levantaba tan campante y **cualquier POST anónimo** podía
 * reportar un `CHARGE_SUCCESS` a Saleor y marcar como pagada una orden que
 * nadie pagó. Una App caída se detecta en minutos; una App que acepta pagos
 * falsos puede tardar semanas en detectarse, y para entonces ya se despachó
 * mercancía. Por eso: sin secret, el proceso no arranca.
 *
 * ── Dos clases de variable, dos fallos distintos ─────────────────────────────
 *
 * No todas las variables ausentes significan lo mismo, y meterlas en la misma
 * lista creó un candado de arranque. La pregunta que las separa es:
 *
 *   *¿qué pasa si la App arranca sin esta variable?*
 *
 * | Clase                       | Sin ella la App…                         | Arranque   |
 * |-----------------------------|------------------------------------------|------------|
 * | `VARIABLES_OBLIGATORIAS`    | …es **insegura** o cobra mal              | **aborta** |
 * | `VARIABLES_DE_OPERACION`    | …**no puede operar todavía**, pero es inocua | degradado |
 * | `VARIABLES_OPCIONALES`      | …funciona con un default razonable        | normal     |
 *
 * `SALEOR_APP_TOKEN` es el caso que obligó a inventar la clase del medio.
 * Estaba en las obligatorias, y eso hacía **imposible aprovisionar una
 * instancia nueva**, porque el token es un huevo-y-gallina:
 *
 *   1. Para obtener el token hay que instalar la App en Saleor.
 *   2. Para instalarla, Saleor descarga `/api/manifest` de la App…
 *   3. …y hace POST del token a `/api/register` de la App.
 *   4. La App tiene que estar **viva** en los pasos 2 y 3.
 *   5. Y si el POST del paso 3 falla, Saleor **borra la App entera** y revierte
 *      la instalación (verificado en el fork: `saleor/app/installation_utils.py`,
 *      líneas 302-306).
 *
 * Es decir: con el token como bloqueante de arranque, la App no arranca hasta
 * tener el token, y no puede tener el token hasta arrancar. Candado cerrado.
 *
 * La salida NO es debilitar la seguridad, porque el token no protege nada: es
 * una credencial de *salida* (autentica a la App **contra** Saleor). Sin él la
 * App no puede reportar pagos — no puede reportarlos **mal**. Ese es
 * exactamente el fallo "no puede operar todavía", y el lado seguro es arrancar,
 * decirlo a gritos en el log, y **rechazar con 503** todo endpoint que necesite
 * hablar con Saleor hasta que el token exista.
 *
 * `WOMPI_EVENTS_SECRET` es el contraejemplo y se queda bloqueante: es una
 * credencial de *entrada* (verifica lo que llega). Sin ella la App no se queda
 * sin poder operar — opera **mal**, aceptando confirmaciones de pago anónimas.
 * Un 503 no arregla eso, porque el daño lo hace justo el endpoint que atendería.
 */

/**
 * Variables sin las cuales la App es **insegura o cobra mal** → el proceso no
 * arranca. Cada una lleva el motivo por el que es obligatoria — si mañana
 * alguien quiere degradar una, tiene aquí el argumento que debe refutar.
 *
 * El criterio para entrar aquí, y no en `VARIABLES_DE_OPERACION`, es que la
 * App **haga daño** operando sin la variable, no que se quede corta.
 */
export const VARIABLES_OBLIGATORIAS: ReadonlyArray<{ nombre: string; motivo: string }> = [
  {
    nombre: 'WOMPI_EVENTS_SECRET',
    motivo:
      'entra en el SHA-256 que firma los webhooks entrantes de Wompi (ver lib/wompi-signature.ts); ' +
      'sin él no se puede verificar ninguna firma y la App aceptaría confirmaciones de pago anónimas',
  },
  {
    nombre: 'SALEOR_API_URL',
    motivo: 'destino de transactionEventReport y origen de la clave pública para verificar el JWS de Saleor',
  },
  {
    nombre: 'WOMPI_PUBLIC_KEY',
    motivo: 'se entrega al storefront en PAYMENT_GATEWAY_INITIALIZE_SESSION y firma las consultas al merchant',
  },
  {
    nombre: 'WOMPI_PRIVATE_KEY',
    motivo: 'autentica la creación, el reembolso y la anulación de transacciones contra la API de Wompi',
  },
  {
    nombre: 'WOMPI_INTEGRITY_KEY',
    motivo:
      'firma de integridad del cobro; Wompi la recalcula y rechaza la transacción si no coincide. ' +
      'Vacía, todas las transacciones se rechazan',
  },
]

/**
 * Variables sin las cuales la App **no puede operar todavía**, pero cuya
 * ausencia no la vuelve insegura → arranca en **modo degradado** y lo dice.
 *
 * Se obtienen *después* de instalar la App en Saleor, y la instalación exige
 * que la App ya esté viva (ver la cabecera de este archivo). Tratarlas como
 * bloqueantes de arranque cierra el candado del aprovisionamiento.
 *
 * En modo degradado la App:
 *  - sirve `/api/manifest`, `/api/register` y `/api/health` — lo que hace falta
 *    para *poder instalarse* y para que el orquestador no la mate mientras;
 *  - responde **503** en todo endpoint que necesite hablar con Saleor.
 */
export const VARIABLES_DE_OPERACION: ReadonlyArray<{ nombre: string; motivo: string }> = [
  {
    nombre: 'SALEOR_APP_TOKEN',
    motivo:
      'autentica las mutaciones de la App contra Saleor (transactionEventReport). Sin él la App no ' +
      'puede reportar pagos, pero tampoco puede reportarlos mal: es una credencial de salida, no de ' +
      'entrada. Solo existe DESPUÉS de instalar la App, y la instalación requiere la App viva',
  },
]

/**
 * Variables opcionales, documentadas aquí para que quede explícito que su
 * ausencia es deliberada y no un olvido. Todas tienen un default razonable
 * para desarrollo local; en producción conviene fijarlas, pero su ausencia
 * no puede cobrar de más ni aceptar pagos falsos, que es el criterio que
 * separa obligatoria de opcional.
 */
export const VARIABLES_OPCIONALES: ReadonlyArray<{ nombre: string; porDefecto: string }> = [
  { nombre: 'APP_URL', porDefecto: 'http://localhost:3001' },
  { nombre: 'STOREFRONT_URL', porDefecto: 'http://localhost:3000' },
  { nombre: 'PORT', porDefecto: '3001' },
  { nombre: 'WOMPI_SANDBOX', porDefecto: 'true (cualquier valor distinto de "false" es sandbox)' },
  { nombre: 'SALEOR_APP_ID', porDefecto: 'sin uso en runtime; informativo tras instalar la App' },
  { nombre: 'APL', porDefecto: 'env' },
]

/**
 * Devuelve los nombres de las variables obligatorias ausentes o vacías.
 * Una variable presente pero con valor vacío (`WOMPI_EVENTS_SECRET=`) cuenta
 * como ausente: es exactamente el caso que producía el `if (secret && ...)`.
 *
 * Función pura sobre el entorno que se le pasa — sin `process.exit`, sin
 * logging — para poder probarla sin tumbar el runner de tests.
 */
export function variablesObligatoriasFaltantes(env: NodeJS.ProcessEnv): string[] {
  return faltantes(VARIABLES_OBLIGATORIAS, env)
}

/**
 * Devuelve los nombres de las variables de operación ausentes o vacías.
 * A diferencia de las obligatorias, esta lista NO aborta el arranque: alimenta
 * el aviso de modo degradado y el 503 de los endpoints que hablan con Saleor.
 */
export function variablesDeOperacionFaltantes(env: NodeJS.ProcessEnv = process.env): string[] {
  return faltantes(VARIABLES_DE_OPERACION, env)
}

/**
 * ¿La App está registrada en Saleor, es decir, puede autenticar sus mutaciones?
 *
 * Se lee del entorno en cada llamada a propósito, sin cachear: es una operación
 * de microsegundos sobre `process.env` y así el healthcheck dice la verdad
 * también en desarrollo, donde `--watch` recarga el `.env` sin reiniciar.
 * Además mantiene el healthcheck barato — no hace ni una llamada de red.
 */
export function appRegistrada(env: NodeJS.ProcessEnv = process.env): boolean {
  return variablesDeOperacionFaltantes(env).length === 0
}

/** Ausente o presente-pero-vacía cuentan igual: `SALEOR_APP_TOKEN=` no sirve. */
function faltantes(lista: ReadonlyArray<{ nombre: string }>, env: NodeJS.ProcessEnv): string[] {
  return lista
    .filter(({ nombre }) => {
      const valor = env[nombre]
      return valor === undefined || valor.trim() === ''
    })
    .map(({ nombre }) => nombre)
}

/**
 * Valida la configuración y lanza si falta algo obligatorio.
 * El mensaje nombra **todas** las variables que faltan, no solo la primera:
 * quien aprovisiona una instancia nueva arregla el .env de una pasada en vez
 * de descubrir las variables de a una por deploy fallido.
 *
 * @throws {Error} Si falta al menos una variable obligatoria.
 */
export function validarConfiguracion(env: NodeJS.ProcessEnv = process.env): void {
  const faltantes = variablesObligatoriasFaltantes(env)
  if (faltantes.length === 0) return

  const detalle = VARIABLES_OBLIGATORIAS.filter(({ nombre }) => faltantes.includes(nombre))
    .map(({ nombre, motivo }) => `  - ${nombre}: ${motivo}`)
    .join('\n')

  throw new Error(
    `Configuración incompleta: falta${faltantes.length > 1 ? 'n' : ''} ${faltantes.length} ` +
      `variable${faltantes.length > 1 ? 's' : ''} de entorno obligatoria${faltantes.length > 1 ? 's' : ''}.\n` +
      `${detalle}\n` +
      'La App no arranca sin ellas. Ver apps/wompi/.env.example.',
  )
}

/**
 * Punto de entrada del fail-fast: valida y, si falla, escribe el motivo en
 * stderr y termina el proceso con código ≠ 0.
 *
 * Se usa `console.error` y no el logger de Fastify a propósito: esto corre
 * ANTES de que exista servidor, y el mensaje tiene que aparecer en los logs
 * de build/arranque de Railway aunque nada más haya llegado a inicializarse.
 */
export function verificarConfiguracionAlArranque(env: NodeJS.ProcessEnv = process.env): void {
  try {
    validarConfiguracion(env)
  } catch (error) {
    console.error(`[app-wompi] ${(error as Error).message}`)
    process.exit(1)
  }
}

/**
 * Mensaje de arranque en modo degradado, o `null` si la App está operativa.
 *
 * Existe para que el arranque degradado sea **imposible de confundir** con un
 * arranque sano leyendo el log: sin este aviso, la única diferencia observable
 * entre las dos situaciones sería un 503 la primera vez que alguien pague.
 */
export function mensajeModoDegradado(env: NodeJS.ProcessEnv = process.env): string | null {
  const pendientes = variablesDeOperacionFaltantes(env)
  if (pendientes.length === 0) return null

  const detalle = VARIABLES_DE_OPERACION.filter(({ nombre }) => pendientes.includes(nombre))
    .map(({ nombre, motivo }) => `  - ${nombre}: ${motivo}`)
    .join('\n')

  return (
    'MODO DEGRADADO: la App arrancó pero NO está registrada en Saleor.\n' +
    `${detalle}\n` +
    'Sirve /api/manifest, /api/register y /api/health para poder instalarse; ' +
    'los webhooks de pago y el webhook entrante de Wompi responden 503 hasta que se registre. ' +
    'Instalar la App en el Dashboard de Saleor, poner el token en el entorno y reiniciar.'
  )
}
