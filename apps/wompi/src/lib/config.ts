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
 */

/**
 * Variables sin las cuales la App no puede operar correctamente.
 * Cada una lleva el motivo por el que es obligatoria — si mañana alguien
 * quiere degradar una a opcional, tiene aquí el argumento que debe refutar.
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
    nombre: 'SALEOR_APP_TOKEN',
    motivo: 'sin él ninguna mutación contra Saleor autentica; los pagos confirmados nunca llegarían a la orden',
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
  return VARIABLES_OBLIGATORIAS.filter(({ nombre }) => {
    const valor = env[nombre]
    return valor === undefined || valor.trim() === ''
  }).map(({ nombre }) => nombre)
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
