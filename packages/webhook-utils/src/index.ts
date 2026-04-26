/**
 * Saleor Webhook Signature Verification
 *
 * HOW SALEOR SIGNS WEBHOOKS (app-registered via manifest):
 *
 * When a webhook is registered via the app manifest (no secretKey), Saleor signs
 * the request body using JWS (JSON Web Signature) with RS256 and its RSA private key.
 * The signature uses RFC 7797 (b64=false, detached payload):
 *   - Header:  BASE64URL({ alg: "RS256", kid: "...", crit: ["b64"], b64: false })
 *   - Payload: raw request body bytes (NOT base64url-encoded, NOT in the token)
 *   - Token format in `Saleor-Signature` header: "<header>..<signature>"
 *
 * Saleor's public keys are available at: {SALEOR_API_URL_BASE}/.well-known/jwks.json
 *
 * USAGE IN EVERY APP:
 *
 *   import { verifySaleorWebhook, SaleorWebhookError } from '@licona/webhook-utils'
 *
 *   const saleorApiUrl = process.env.SALEOR_API_URL!
 *
 *   app.post('/api/webhooks/my-event', async (request, reply) => {
 *     const signature = request.headers['saleor-signature'] as string
 *     const rawBody   = JSON.stringify(request.body)
 *
 *     try {
 *       await verifySaleorWebhook(rawBody, signature, saleorApiUrl)
 *     } catch (e) {
 *       return reply.status(401).send({ error: 'Invalid webhook signature' })
 *     }
 *
 *     // ... handle the verified event
 *   })
 *
 * DO NOT use HMAC / a shared secret for app-registered webhooks — Saleor does not
 * set a secretKey on webhooks created from the manifest. HMAC is only used for
 * manually created webhooks that explicitly have a secretKey.
 */

import { createRemoteJWKSet, flattenedVerify } from 'jose'

export class SaleorWebhookError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'SaleorWebhookError'
  }
}

// Cache one JWKS instance per Saleor API URL to avoid refetching keys on every request.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJWKS(saleorApiUrl: string) {
  const baseUrl = saleorApiUrl.replace(/\/graphql\/?$/, '').replace(/\/$/, '')
  const jwksUrl = `${baseUrl}/.well-known/jwks.json`

  if (!jwksCache.has(jwksUrl)) {
    jwksCache.set(jwksUrl, createRemoteJWKSet(new URL(jwksUrl)))
  }
  return jwksCache.get(jwksUrl)!
}

/**
 * Verify the `Saleor-Signature` header on an incoming webhook request.
 *
 * @param rawBody      - Raw request body string (JSON.stringify(request.body))
 * @param signature    - Value of the `Saleor-Signature` header
 * @param saleorApiUrl - Full Saleor GraphQL URL, e.g. "https://api.example.com/graphql/"
 *
 * @throws SaleorWebhookError if the signature is missing, malformed, or invalid.
 */
export async function verifySaleorWebhook(
  rawBody: string,
  signature: string | undefined,
  saleorApiUrl: string,
): Promise<void> {
  if (!signature) {
    throw new SaleorWebhookError('Missing Saleor-Signature header')
  }

  // Compact JWS with detached payload: "<header>..<sig>" (two dots, empty middle)
  const parts = signature.split('.')
  if (parts.length !== 3) {
    throw new SaleorWebhookError('Malformed Saleor-Signature: expected compact JWS')
  }
  const [protectedHeader, , sig] = parts

  try {
    await flattenedVerify(
      {
        protected: protectedHeader,
        payload: Buffer.from(rawBody),
        signature: sig,
      },
      getJWKS(saleorApiUrl),
    )
  } catch (err) {
    throw new SaleorWebhookError('Webhook signature verification failed', err)
  }
}
