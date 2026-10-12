import type { Tx } from './db.ts'
export async function inboxSettings(db: Tx, actorId: string) {
  const row = await db.agentAction.findFirst({ where: { agentUserId: actorId, action: 'receipt.inbox.mode' }, orderBy: { id: 'desc' } })
  return { autoStash: Boolean((row?.detail as any)?.autoStash), scope: 'your incoming photos', fundingDefault: 'STALL_FUNDS' }
}
