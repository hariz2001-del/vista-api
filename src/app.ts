import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { env } from './env.ts'
import { DomainError, messageFor } from './errors.ts'
import { authRoutes } from './routes/auth.ts'
import { bootstrapRoutes } from './routes/bootstrap.ts'
import { checkoutRoutes } from './routes/checkout.ts'
import { shiftRoutes } from './routes/shifts.ts'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: 'info' },
    // Behind Nginx, so the client address comes from the proxy header.
    trustProxy: true,
  })

  await app.register(cors, { origin: true, credentials: true })
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '12h' } })

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

  await app.register(authRoutes)
  await app.register(bootstrapRoutes)
  await app.register(shiftRoutes)
  await app.register(checkoutRoutes)

  return app
}
