import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { ATTEMPT_LIMIT, AttemptStore } from './attempts.ts'
import { env } from './env.ts'
import { DomainError, messageFor } from './errors.ts'
import { authRoutes } from './routes/auth.ts'
import { bootstrapRoutes } from './routes/bootstrap.ts'
import { checkoutRoutes } from './routes/checkout.ts'
import { correctionRoutes } from './routes/corrections.ts'
import { menuRoutes } from './routes/menu.ts'
import { promotionRoutes } from './routes/promotions.ts'
import { rmsRoutes } from './routes/rms.ts'
import { shiftRoutes } from './routes/shifts.ts'
import { terminalRoutes } from './routes/terminal.ts'

export type AppOptions = {
  /**
   * Wrong-password and wrong-PIN attempts allowed per 15 minutes, per client.
   * Production uses the default. The test suites raise it so their own many
   * logins do not trip it; test/attempts.test.ts checks the real limit.
   */
  attemptLimit?: number
  /**
   * New businesses per hour, per client. Production uses the default; the test
   * suites raise it because they register a business for nearly every test.
   */
  registrationLimit?: number
}

/** Registration is open to anyone, so one address gets a handful an hour. */
export const REGISTRATION_LIMIT = 5

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const attempts = { attemptLimit: options.attemptLimit ?? ATTEMPT_LIMIT }
  const authOptions = {
    ...attempts,
    registrationLimit: options.registrationLimit ?? REGISTRATION_LIMIT,
  }

  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: 'info' },
    // Behind Vercel's edge, so the client address comes from X-Forwarded-For,
    // which Vercel sets and overwrites — a client cannot supply its own.
    trustProxy: true,
  })

  // The methods must be listed: @fastify/cors defaults to GET, HEAD and POST
  // only, so a browser's preflight for the RMS's PUT (settings), PATCH and
  // DELETE (menu) is refused and the request never leaves the page. Server-side
  // tests use inject(), which skips CORS entirely — test/cors.test.ts covers that gap.
  await app.register(cors, {
    // Only the hub, counter and dashboard sites (CORS_ORIGINS). A page on any
    // other site gets no CORS headers, so the browser withholds the response
    // from it. This is not the lock on its own — anything outside a browser can
    // still call — the session check is. Tokens travel in a header, not a
    // cookie, so credentials are not needed.
    origin: env.CORS_ORIGINS,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  // No default expiry: a counter session must not time out mid-service. Owner
  // sessions are given their expiry where they are signed (routes/auth.ts), and
  // every token is checked against its session row, which the RMS can revoke.
  await app.register(jwt, { secret: env.JWT_SECRET })

  // Filled in by the session check (src/auth.ts) on every authenticated route.
  // Fastify refuses an object as a decorator default, so the client starts as
  // null and is set per request.
  app.decorateRequest('businessId', '')
  app.decorateRequest('db', null as unknown as PrismaClient)

  // Off by default; only the login and PIN routes opt in (src/attempts.ts).
  // The refusal is a DomainError, so it leaves through the same error handler
  // as everything else and the counter shows a plain-language message.
  await app.register(rateLimit, {
    global: false,
    // Counted in Postgres: serverless copies share no memory (src/attempts.ts).
    store: AttemptStore,
    errorResponseBuilder: () =>
      new DomainError('auth:TOO_MANY_ATTEMPTS', 429, messageFor('auth:TOO_MANY_ATTEMPTS')),
  })

  /**
   * Nothing raw ever reaches the counter. A cashier needs to know whether to
   * take the money again — a Postgres error string cannot tell them that.
   */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, error.code)
      else request.log.info({ code: error.code, detail: error.detail }, 'domain error')
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(env.NODE_ENV !== 'production' && error.detail ? { detail: error.detail } : {}),
      })
    }

    if (error instanceof ZodError) {
      request.log.info({ issues: error.issues }, 'validation error')
      return reply.status(400).send({
        error: 'validation:INVALID_REQUEST',
        message: messageFor('validation:INVALID_REQUEST'),
        ...(env.NODE_ENV !== 'production' ? { detail: error.issues } : {}),
      })
    }

    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({
      error: 'server:UNEXPECTED',
      message: messageFor('server:UNEXPECTED'),
    })
  })

  app.get('/healthz', async () => {
    const { prisma } = await import('./db.ts')
    await prisma.$queryRaw`SELECT 1`
    return { ok: true }
  })

  await app.register(authRoutes, authOptions)
  await app.register(bootstrapRoutes)
  await app.register(shiftRoutes, attempts)
  await app.register(checkoutRoutes)
  await app.register(correctionRoutes)
  await app.register(terminalRoutes)
  await app.register(rmsRoutes)
  await app.register(menuRoutes)
  await app.register(promotionRoutes)

  return app
}
