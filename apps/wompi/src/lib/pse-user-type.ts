/**
 * `user_type` de PSE (B-2451). Wompi exige un ENTERO para PSE (0 = persona natural,
 * 1 = persona jurídica); el storefront envía 'PERSON' | 'COMPANY'. La traducción vive aquí,
 * en la frontera. BANCOLOMBIA_TRANSFER NO pasa por esto: sigue usando el string "PERSON".
 */

export type ResultadoUserTypePse = { ok: true; userType: 0 | 1 } | { ok: false; message: string }

export function traducirUserTypePse(valor: unknown): ResultadoUserTypePse {
  if (valor === undefined || valor === 'PERSON' || valor === 0 || valor === '0') return { ok: true, userType: 0 }
  if (valor === 'COMPANY' || valor === 1 || valor === '1') return { ok: true, userType: 1 }
  return { ok: false, message: 'El tipo de persona para PSE no es válido. Elige persona natural o jurídica.' }
}
