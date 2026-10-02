import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { requireStaff } from '../auth.ts'

/**
 * Team, staff side: what team.vistahub.my calls once signed in.
 *
 * Everything a staff member can see is built here, field by field. Nothing
 * from management's side of a record — ratings, notes, scores, the engine's
 * reasons, other people's pay — is ever selected, let alone sent.
 */

async function orgName(db: PrismaClient, businessId: string): Promise<string> {
  const settings = await db.accountSettings.findUnique({
    where: { businessId },
    select: { businessName: true },
  })
  return settings?.businessName ?? 'Your workplace'
}

export async function teamStaffRoutes(app: FastifyInstance): Promise<void> {
  app.post('/team/auth/logout', { preHandler: requireStaff }, async (request) => {
    await request.db.session.update({
      where: { id: request.user.sid },
      data: { revokedAt: new Date() },
    })
    return { ok: true }
  })

  app.get('/team/me', { preHandler: requireStaff }, async (request) => {
    const staff = await request.db.staffMember.findUniqueOrThrow({
      where: { id: request.staffId },
      select: { id: true, name: true, staffCode: true },
    })
    return {
      staff,
      org: { id: request.businessId, name: await orgName(request.db, request.businessId) },
    }
  })
}
