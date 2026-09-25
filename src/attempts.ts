import type { FastifyRequest } from 'fastify'
import { prisma } from './db.ts'

/**
 * Guessing limits for the two secrets: the account password and the counter PIN.
 *
 * The business has one account, so its password is the whole business, and a
 * 4-digit PIN has only 10,000 values. Each is limited to this many attempts per
 * window, per client, per route.
 */
export const ATTEMPT_LIMIT = 10
export const ATTEMPT_WINDOW = '15 minutes'

export type AttemptOptions = { attemptLimit: number }

/**
 * Who is guessing: the client's address. Vercel sets X-Forwarded-For itself and
 * overwrites whatever the client sent, and with `trustProxy` Fastify reads
 * `request.ip` from it. Locally and in tests it is the same header or the socket.
 *
 * Deliberately not CF-Connecting-IP: nothing strips that header on the way to
 * Vercel, so a guesser could send a fresh one with every attempt.
 */
export function clientKey(request: FastifyRequest): string {
  return request.ip
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

type IncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void

/**
 * Where attempts are counted: Postgres, not memory. On Vercel the API runs as
 * functions — several copies can be alive at once and any can be recycled at
 * any moment — so a count held in one copy's memory would be split between
 * copies and forgotten on every cold start: ten guesses per copy per start
 * rather than ten per window.
 *
 * @fastify/rate-limit builds one of these per limited route (`child`), so the
 * sign-in and PIN routes keep separate counts, as they did in memory.
 */
export class AttemptStore {
  private readonly scope: string

  constructor(options: object = {}) {
    const route = (options as { routeInfo?: { method?: unknown; url?: unknown } }).routeInfo
    this.scope = `${String(route?.method ?? '')} ${String(route?.url ?? '')}`
  }

  incr(key: string, callback: IncrCallback, timeWindow = 15 * 60_000): void {
    countAttempt(`${this.scope} ${key}`, timeWindow).then(
      (result) => callback(null, result),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    )
  }

  child(routeOptions: object): AttemptStore {
    return new AttemptStore(routeOptions)
  }
}

/**
 * One atomic upsert: starts a fresh window if the last one has ended, otherwise
 * adds one, and says how long the window has left. Two copies counting the same
 * client at once serialise on the row, so neither loses the other's attempt.
 */
async function countAttempt(key: string, windowMs: number): Promise<{ current: number; ttl: number }> {
  const rows = await prisma.$queryRaw<Array<{ count: number; ttl_ms: number }>>`
    INSERT INTO attempt_counters (key, count, reset_at)
    VALUES (${key}, 1, now() + ${windowMs}::int * interval '1 millisecond')
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN attempt_counters.reset_at <= now() THEN 1
                   ELSE attempt_counters.count + 1 END,
      reset_at = CASE WHEN attempt_counters.reset_at <= now() THEN EXCLUDED.reset_at
                      ELSE attempt_counters.reset_at END
    RETURNING count, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (reset_at - now())) * 1000))::int AS ttl_ms
  `
  const row = rows[0]
  if (!row) throw new Error('attempt counter upsert returned no row')

  // A finished window is worth nothing. Clearing them on the way past keeps the
  // table to the few clients seen in the last quarter hour.
  await prisma.attemptCounter.deleteMany({ where: { resetAt: { lt: new Date() } } })

  return { current: row.count, ttl: row.ttl_ms }
}
