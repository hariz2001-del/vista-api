import type { Prisma } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import type { Tx } from '../db.ts'

/** Who did something: management, a staff member, or the system itself. */
export type Actor = {
  kind: 'OWNER' | 'MANAGER' | 'STAFF' | 'SYSTEM'
  id: string | null
  label: string
}

export const SYSTEM_ACTOR: Actor = { kind: 'SYSTEM', id: null, label: 'System' }

/**
 * The actor behind a request. Management is the business account today; a
 * staff session is the staff member on its row.
 */
export async function actorOf(request: FastifyRequest): Promise<Actor> {
  if (request.user.scope === 'STAFF' && request.staffId) {
    const staff = await request.db.staffMember.findUnique({
      where: { id: request.staffId },
      select: { name: true },
    })
    return { kind: 'STAFF', id: request.staffId, label: staff?.name ?? 'Staff' }
  }
  return { kind: 'OWNER', id: request.user.id, label: 'Management' }
}

type AuditInput = {
  action: string
  entityType: string
  entityId?: string | null
  before?: unknown
  after?: unknown
}

/** JSON-safe: BigInt and Date become strings, undefined disappears. */
function snapshot(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === 'bigint' ? inner.toString() : inner,
    ),
  ) as Prisma.InputJsonValue
}

/**
 * Append one line to the business's Team audit trail. Written in the same
 * transaction as the change it describes, so the trail can never claim
 * something happened that rolled back. The table refuses updates and deletes.
 */
export async function audit(
  tx: Tx,
  businessId: string,
  actor: Actor,
  input: AuditInput,
): Promise<void> {
  await tx.teamAuditEntry.create({
    data: {
      businessId,
      actorKind: actor.kind,
      actorId: actor.id,
      actorLabel: actor.label,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: snapshot(input.before),
      after: snapshot(input.after),
    },
  })
}
