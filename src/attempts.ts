import type { FastifyRequest } from 'fastify'

/**
 * Guessing limits for the two secrets: the account password and the counter PIN.
 *
 * The business has one account, so its password is the whole business, and a
 * 4-digit PIN has only 10,000 values. Each is limited to this many attempts per
 * window, per client. Counted in memory, which is correct for the single API
 * process Vista runs (see deploy/ecosystem.config.cjs); a restart resets it.
 */
export const ATTEMPT_LIMIT = 10
export const ATTEMPT_WINDOW = '15 minutes'

export type AttemptOptions = { attemptLimit: number }

/**
 * Who is guessing. Behind Cloudflare every request arrives from a Cloudflare
 * address, so the real visitor is in CF-Connecting-IP — trustworthy only
 * because the server accepts HTTPS from Cloudflare's ranges alone. Elsewhere
 * (local, tests) it is the socket address.
 */
export function clientKey(request: FastifyRequest): string {
  const forwarded = request.headers['cf-connecting-ip']
  const viaCloudflare = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return viaCloudflare ?? request.ip
}

/** Route config that applies the limit. Spread into a route's `config`. */
export function attemptLimitConfig(options: AttemptOptions) {
  return {
    rateLimit: {
      max: options.attemptLimit,
      timeWindow: ATTEMPT_WINDOW,
      keyGenerator: clientKey,
    },
  }
}
