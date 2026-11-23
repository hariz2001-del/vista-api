import type { Prisma } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import type { Tx } from '../db.ts'

/** Who did something to a campaign. */
export type CampaignActor = {
  kind: 'OWNER' | 'STAFF' | 'AGENT' | 'SYSTEM'
  id: string | null
  label: string
}

export const SYSTEM: CampaignActor = { kind: 'SYSTEM', id: null, label: 'System' }

/** The actor behind a request: the owner in the RMS, a till, or Hermes. */
export function campaignActor(request: FastifyRequest): CampaignActor {
  if (request.agentUser) return { kind: 'AGENT', id: request.agentUser.id, label: `${request.agentUser.name} via Hermes` }
  if (request.user?.scope === 'COUNTER') return { kind: 'STAFF', id: request.user.id, label: 'Counter' }
  return { kind: 'OWNER', id: request.user?.id ?? null, label: 'Management' }
}

/** JSON-safe: BigInt and Date become strings, undefined disappears. */
function snapshot(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)),
  ) as Prisma.InputJsonValue
}

/**
 * One line on the campaign's audit trail, in the same transaction as the change
 * it describes. The table refuses updates and deletes.
 */
export async function campaignAudit(
  tx: Tx,
  businessId: string,
  actor: CampaignActor,
  input: { campaignId: string; orderId?: string | null; action: string; before?: unknown; after?: unknown },
): Promise<void> {
  await tx.campaignAuditEntry.create({
    data: {
      businessId,
      campaignId: input.campaignId,
      orderId: input.orderId ?? null,
      actorKind: actor.kind,
      actorId: actor.id,
      actorLabel: actor.label,
      action: input.action,
      before: snapshot(input.before),
      after: snapshot(input.after),
    },
  })
}
