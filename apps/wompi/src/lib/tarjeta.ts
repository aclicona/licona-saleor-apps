/**
 * Validación de los datos de tarjeta que llegan en `paymentData` (B-707).
 *
 * `data` viaja por el navegador del comprador: es entrada no confiable. Aquí solo
 * se acepta lo estrictamente necesario para pedir un cobro con tarjeta tokenizada
 * (el token y las cuotas) y NADA de esto se usa para otra cosa (referencia, monto,
 * correo…). El PAN/CVC nunca pasan por la App: los tokeniza el navegador contra
 * Wompi con la llave pública.
 */

export const CUOTAS_MIN = 1
export const CUOTAS_MAX = 36
const CUOTAS_POR_DEFECTO = 1

// Los tokens de Wompi tienen la forma `tok_<ambiente>_<id>_<sufijo>`; se exige el
// prefijo, solo caracteres seguros y un tope de largo para no reenviar basura.
const TOKEN_RE = /^tok_[A-Za-z0-9_-]{1,120}$/

export type TarjetaValida = { token: string; installments: number }
export type ResultadoTarjeta = { ok: true; tarjeta: TarjetaValida } | { ok: false; message: string }

export function validarDatosTarjeta(data: { token?: unknown; installments?: unknown } | undefined): ResultadoTarjeta {
  const token = data?.token
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    return { ok: false, message: 'Falta el token de la tarjeta o no es válido. Vuelve a ingresar los datos de la tarjeta.' }
  }

  const cuotas = data?.installments ?? CUOTAS_POR_DEFECTO
  if (typeof cuotas !== 'number' || !Number.isInteger(cuotas) || cuotas < CUOTAS_MIN || cuotas > CUOTAS_MAX) {
    return { ok: false, message: `El número de cuotas debe ser un entero entre ${CUOTAS_MIN} y ${CUOTAS_MAX}.` }
  }

  return { ok: true, tarjeta: { token, installments: cuotas } }
}
