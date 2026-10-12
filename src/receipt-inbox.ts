import type { Tx } from './db.ts'
export async function inboxSettings(db: Tx, actorId: string) {
  const row = await db.agentAction.findFirst({ where: { agentUserId: actorId, action: 'receipt.inbox.mode' }, orderBy: { id: 'desc' } })
  const detail=row?.detail as any
  return { autoStash: Boolean(detail?.autoStash), bulk: Boolean(detail?.bulk), bulkId: detail?.bulkId ?? null, scope: 'your incoming photos', fundingDefault: 'STALL_FUNDS' }
}
