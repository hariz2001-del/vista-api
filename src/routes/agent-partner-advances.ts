import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { conflict, notFound } from '../errors.ts'
import { assertNotLocked, toDate } from './rms.ts'
import { refreshClosing } from './agent-closing.ts'

const bodySchema = z.object({
  businessDate: z.iso.date(), amountSen: z.number().int().positive().max(2_000_000_000),
  partnerBrandId: z.uuid(), receiptKey: z.string().regex(/^R-[A-F0-9]{6}$/),
  bankReference: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9-]+$/).transform(s => s.toUpperCase()),
  description: z.string().trim().min(1).max(200), confirmedAlreadyPaid: z.literal(true),
}).strict()

/** Record an evidenced repayment, never a new operating expense or invented advance. */
export async function agentPartnerAdvanceRoutes(app: FastifyInstance) {
  const owner = { preHandler: requireAgent('OWNER') }
  app.get('/agent/partner-advances/repayments', owner, async r => ({ repayments: await r.db.reconciliationCase.findMany({
    where: { kind: 'PARTNER_ADVANCE_REPAYMENT' }, orderBy: { createdAt: 'desc' }, take: 100,
  }) }))
  app.post('/agent/partner-advances/repayments', owner, async r => {
    const b = bodySchema.parse(r.body)
    return r.db.$transaction(async tx => {
      const key = `partner-repayment:${b.bankReference}`
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':' + key}))::text`
      const prior = await tx.reconciliationCase.findFirst({ where: { key } })
      if (prior) {
        const d = prior.detail as any
        if (prior.kind !== 'PARTNER_ADVANCE_REPAYMENT' || d.direction === 'MONEY_IN') throw conflict('agent:TRANSFER_DIRECTION_CORRECTED', 'This transfer was corrected to incoming funds. Do not record or replay it as a repayment.')
        if (d.businessDate !== b.businessDate || d.amountSen !== b.amountSen || d.partnerBrandId !== b.partnerBrandId) throw conflict('agent:TRANSFER_ALREADY_RECORDED')
        return { saved: true, replayed: true, repayment: prior }
      }
      await assertNotLocked(tx, b.businessDate)
      const brand = await tx.brand.findUnique({ where: { id: b.partnerBrandId } })
      if (!brand) throw notFound('rms:UNKNOWN_BRAND')
      const stash = await tx.chopperStash.findFirst({ where: { receiptKey: b.receiptKey } })
      const data = stash?.data as any
      const reading = data?.reading
      if (data?.transferDirection === 'MONEY_IN' || data?.partnerAdvance?.direction === 'MONEY_IN') throw conflict('agent:TRANSFER_DIRECTION_MISMATCH', 'Owner confirmed these funds entered the business; this evidence cannot support an outgoing repayment.')
      if (!data?.scanVerified || !data.fileId || !reading?.flags?.some((f: string) => ['bank_screenshot', 'bank_statement'].includes(f)) || reading?.date !== b.businessDate || reading?.totalSen !== b.amountSen || reading?.receiptNo?.toUpperCase() !== b.bankReference) {
        throw conflict('agent:TRANSFER_EVIDENCE_MISMATCH', 'The saved bank evidence must show this exact date, amount and reference.')
      }
      // Matching amounts are not proof of identity. Stop for review rather than
      // blindly making another repayment or duplicating an existing expense.
      if (await tx.ledgerEntry.findFirst({ where: { businessDate: toDate(b.businessDate), direction: 'MONEY_OUT', amountSen: b.amountSen } })) {
        throw conflict('agent:POSSIBLE_DUPLICATE', 'An outgoing entry already has this date and amount. Review/link it first.')
      }
      const entry = await tx.ledgerEntry.create({ data: { businessId: r.businessId, businessDate: toDate(b.businessDate),
        direction: 'MONEY_OUT', amountSen: b.amountSen, category: 'LOAN_REPAYMENT', brandId: brand.id,
        description: `${brand.name} partner advance repayment · ${b.bankReference} · ${b.description}` } })
      const repayment = await tx.reconciliationCase.create({ data: { businessId: r.businessId, key, kind: 'PARTNER_ADVANCE_REPAYMENT', status: 'OPEN', detail: {
        businessDate: b.businessDate, amountSen: b.amountSen, partnerBrandId: brand.id, partnerName: `${brand.name} partner`,
        bankReference: b.bankReference, receiptKey: b.receiptKey, evidenceFileId: data.fileId, description: b.description,
        ledgerEntryId: entry.id.toString(), paymentStatus: 'PAID', classification: 'ADVANCE_REPAYMENT',
        sourceStatus: 'AWAITING_ADVANCE_AND_ORGANISER_RECORDS',
        note: 'Confirmed repayment of temporary coupon funding. No operating expense, sale, advance receipt or organiser receipt was invented. Original advance and organiser deposit still need linking.',
      } } })
      await tx.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'partner-advance.repayment.recorded',
        entityType: 'ledger', entityId: entry.id.toString(), detail: { ...b, repaymentId: repayment.id } } })
      const closing = await tx.reconciliationCase.findFirst({ where: { key: `closing:${b.businessDate}`, kind: 'DAILY_CLOSING' } })
      let updated = null
      if (closing) { const d = closing.detail as any; updated = await refreshClosing(tx, r.businessId, d.input, { ...d.evidence, [`transfer:${b.bankReference}`]: b.receiptKey }) }
      return { saved: true, replayed: false, repayment, closing: updated }
    })
  })
}
