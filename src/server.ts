import type { FastifyInstance } from 'fastify'
import { buildApp } from './build-app.ts'
import { prisma } from './db.ts'
import { env } from './env.ts'

const app: FastifyInstance = await buildApp()

// Vercel's Fastify support runs this file as one function; the listen call is
// how it picks the app up. Locally it is a plain server on loopback.
//
// Vercel looks for its entrypoint in a fixed order and src/app.ts comes before
// src/server.ts, which is why the app is built in src/build-app.ts: a file named
// app.ts would be taken as the entrypoint, and it never starts a server.
await app.listen({ port: env.PORT, host: '127.0.0.1' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      app.log.info(`${signal} received, shutting down`)
      await app.close()
      await prisma.$disconnect()
      process.exit(0)
    })()
  })
}
