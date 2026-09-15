import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth.ts'
import { prisma } from '../db.ts'

const heartbeatBody = z.object({
  /** Flush attempts in a row that failed to send something, as the tablet counts them. */
  consecutive_sync_failures: z.number().int().min(0).max(100_000).default(0),
})

/**
 * The counter's heartbeat.
 *
 * The owner's status banner needs to tell a quiet shift from a tablet that has
 * dropped off. The server cannot see a tablet that has stopped calling, so the
 * tablet calls in every minute while a shift is open, and silence is the signal.
 */
export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/terminal/heartbeat', { preHandler: requireUser }, async (request) => {
    const body = heartbeatBody.parse(request.body ?? {})
    const data = {
      lastSeenAt: new Date(),
      consecutiveSyncFailures: body.consecutive_sync_failures,
      lastSeenById: request.user.id,
    }
    await prisma.terminalStatus.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    })
    return { ok: true }
  })
}
