import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import type { Tx } from '../db.ts'
import { conflict, notFound } from '../errors.ts'
import { assertNotLocked, toDate } from './rms.ts'
import { refreshClosing } from './agent-closing.ts'

/**
 * Campaign money that does not stay in the stall bank.
 *
 * A campaign partner (SIB) keeps its takings in its own wallet (TNG). Vista
 * books a verified campaign pre-order as REVENUE, which the cash book assumes
 * landed in the stall bank. Three movements reconcile that with what the bank
 * actually held, each one CAMPAIGN_TRANSFER ledger line, never a sale or an
 * operating expense:
 *
 *   MOVED_TO_WALLET    stall bank → campaign wallet           MONEY_OUT
 *   PAID_INTO_WALLET   a campaign customer paid the wallet     MONEY_OUT
 *                      directly, so the booked revenue never
 *                      reached the stall bank
 *   RECEIVED_IN_BANK   campaign money landed in the stall      MONEY_IN
 *                      bank with no Vista sale behind it
 *
 * Daily closings read these as other outflows / inflows. Preview writes only its
 * audit row; confirm is idempotent per confirmation and refuses a second line of
 * the same campaign, kind, date and amount unless the owner says it is separate.
 */

const KINDS = ['MOVED_TO_WALLET', 'PAID_INTO_WALLET', 'RECEIVED_IN_BANK'] as const
type Kind = (typeof KINDS)[number]
const DIRECTION: Record<Kind, 'MONEY_IN' | 'MONEY_OUT'> = {
  MOVED_TO_WALLET: 'MONEY_OUT', PAID_INTO_WALLET: 'MONEY_OUT', RECEIVED_IN_BANK: 'MONEY_IN',
}
const LABEL: Record<Kind, string> = {
  MOVED_TO_WALLET: 'moved from stall bank to',
  PAID_INTO_WALLET: 'paid straight into',
  RECEIVED_IN_BANK: 'received into stall bank for',
}

const transferBody = z.object({
  businessDate: z.iso.date(),
  campaignId: z.uuid(),
  kind: z.enum(KINDS),
  amountSen: z.number().int().positive().max(2_000_000_000),
  wallet: z.string().trim().min(1).max(40).default('TNG'),
  description: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(80).optional(),
}).strict()
type Transfer = z.infer<typeof transferBody>

const CASE_KIND = 'CAMPAIGN_TRANSFER'

async function findCampaign(db: Tx, campaignId: string) {
  const campaign = await db.campaign.findFirst({ where: { id: campaignId }, select: { id: true, name: true, brandId: true } })
  if (!campaign) throw notFound('agent:CAMPAIGN_NOT_FOUND')
  return campaign
}

/** Lines already booked for the same campaign, kind, date and amount. */
async function sameLines(db: Tx, t: Transfer) {
  const cases = await db.reconciliationCase.findMany({ where: { kind: CASE_KIND, status: { not: 'REVERSED' } } })
  return cases.filter((c) => {
    const d = c.detail as Record<string, unknown>
    return d.campaignId === t.campaignId && d.kind === t.kind && d.businessDate === t.businessDate && d.amountSen === t.amountSen
  })
}

const describe = (t: Transfer, campaignName: string) =>
  `${campaignName} · ${LABEL[t.kind]} ${t.wallet} · ${t.description}${t.reference ? ` · ${t.reference}` : ''}`

async function refreshDay(tx: Tx, businessId: string, businessDate: string) {
  const closing = await tx.reconciliationCase.findFirst({ where: { key: `closing:${businessDate}`, kind: 'DAILY_CLOSING' } })
  if (!closing) return null
  const d = closing.detail as any
  return refreshClosing(tx, businessId, d.input, d.evidence)
}

const audit = (r: FastifyRequest, db: Tx, action: string, entityId: string, detail: unknown) =>
  db.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action, entityType: 'campaign-transfer', entityId, detail: JSON.parse(JSON.stringify(detail)) } })

export async function agentCampaignTransferRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireAgent('OWNER') }

  /** Which campaign a transfer belongs to: id, name and status only. */
  app.get('/agent/campaigns', owner, async (r) => ({
    campaigns: await r.db.campaign.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, status: true, brandId: true, startsOn: true, endsOn: true } }),
  }))

  app.get('/agent/campaign-transfers', owner, async (r) => {
    const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(r.query)
    const cases = await r.db.reconciliationCase.findMany({ where: { kind: CASE_KIND }, orderBy: { createdAt: 'asc' } })
    const transfers = cases.map((c) => ({ id: c.id, status: c.status, ...(c.detail as object) }) as { id: string; status: string; businessDate: string })
      .filter((t) => (!q.from || t.businessDate >= q.from) && (!q.to || t.businessDate <= q.to))
    return { transfers }
  })

  app.post('/agent/campaign-transfers/preview', owner, async (r) => {
    const input = transferBody.parse(r.body)
    const campaign = await findCampaign(r.db, input.campaignId)
    let locked = false
    try { await assertNotLocked(r.db, input.businessDate) } catch { locked = true }
    const existing = await sameLines(r.db, input)
    const action = await audit(r, r.db, 'campaign-transfer.preview', input.businessDate, { input })
    return {
      confirmationId: action.id.toString(), locked,
      entry: { businessDate: input.businessDate, direction: DIRECTION[input.kind], amountSen: input.amountSen, category: 'CAMPAIGN_TRANSFER', description: describe(input, campaign.name) },
      existing: existing.map((c) => ({ id: c.id, ...(c.detail as object) })),
      note: 'Not a sale or an expense: moves the stall cash book by the campaign money that left (or entered) the stall bank. Nothing is written until confirm.',
    }
  })

  app.post('/agent/campaign-transfers/confirm', owner, async (r) => {
    const body = z.object({ confirmationId: z.string().regex(/^\d{1,19}$/), separateFromExisting: z.boolean().default(false) }).strict().parse(r.body)
    return r.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':campaign-transfer:' + body.confirmationId}))::text`
      const preview = await tx.agentAction.findFirst({ where: { id: BigInt(body.confirmationId), agentUserId: r.agentUser!.id, action: 'campaign-transfer.preview' } })
      if (!preview) throw notFound('agent:PREVIEW_NOT_FOUND')
      if (Date.now() - preview.createdAt.getTime() > 30 * 60_000) throw conflict('agent:PREVIEW_STALE')
      const done = await tx.agentAction.findFirst({ where: { action: 'campaign-transfer.confirmed', entityId: body.confirmationId } })
      if (done) return { saved: true, replayed: true, ...(done.detail as object) }

      const input = transferBody.parse((preview.detail as { input: unknown }).input)
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':campaign-transfer-line:' + input.campaignId + ':' + input.businessDate}))::text`
      await assertNotLocked(tx, input.businessDate)
      const campaign = await findCampaign(tx, input.campaignId)
      if (!body.separateFromExisting && (await sameLines(tx, input)).length) throw conflict('agent:CAMPAIGN_TRANSFER_EXISTS')

      const entry = await tx.ledgerEntry.create({ data: {
        businessId: r.businessId, businessDate: toDate(input.businessDate), direction: DIRECTION[input.kind],
        amountSen: input.amountSen, category: 'CAMPAIGN_TRANSFER', brandId: campaign.brandId, description: describe(input, campaign.name),
      } })
      const record = await tx.reconciliationCase.create({ data: {
        businessId: r.businessId, key: `campaign-transfer:${entry.id}`, kind: CASE_KIND, status: 'RECORDED',
        detail: { ...input, campaignName: campaign.name, direction: DIRECTION[input.kind], ledgerEntryId: entry.id.toString(), confirmationId: body.confirmationId },
      } })
      await audit(r, tx, 'campaign-transfer.confirmed', body.confirmationId, { transferId: record.id, ledgerEntryId: entry.id.toString() })
      const closing = await refreshDay(tx, r.businessId, input.businessDate)
      return { saved: true, replayed: false, transferId: record.id, ledgerEntryId: entry.id.toString(), closing }
    })
  })

  /** Undo a mistaken line: removes its ledger row, keeps the record as REVERSED. */
  app.post('/agent/campaign-transfers/:id/reverse', owner, async (r) => {
    const { id } = z.object({ id: z.uuid() }).parse(r.params)
    const { reason } = z.object({ reason: z.string().trim().min(1).max(200) }).strict().parse(r.body)
    return r.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':campaign-transfer-reverse:' + id}))::text`
      const record = await tx.reconciliationCase.findFirst({ where: { id, kind: CASE_KIND } })
      if (!record) throw notFound('agent:CAMPAIGN_TRANSFER_NOT_FOUND')
      const d = record.detail as Transfer & { ledgerEntryId: string }
      if (record.status === 'REVERSED') return { reversed: true, replayed: true }
      await assertNotLocked(tx, d.businessDate)
      await tx.ledgerEntry.deleteMany({ where: { id: BigInt(d.ledgerEntryId), category: 'CAMPAIGN_TRANSFER' } })
      await tx.reconciliationCase.update({ where: { id }, data: { status: 'REVERSED', resolution: reason } })
      await audit(r, tx, 'campaign-transfer.reversed', id, { reason, ledgerEntryId: d.ledgerEntryId })
      const closing = await refreshDay(tx, r.businessId, d.businessDate)
      return { reversed: true, replayed: false, closing }
    })
  })
}
