import { buildApp } from './app.ts'
import { prisma } from './db.ts'
import { env } from './env.ts'

const app = await buildApp()

// Bound to loopback: Nginx terminates TLS and proxies in. This port is never
// reachable from outside the box.
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
