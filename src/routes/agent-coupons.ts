import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { conflict, notFound } from '../errors.ts'
import { assertNotLocked, toDate } from './rms.ts'
import { refreshClosing } from './agent-closing.ts'
const date = z.iso.date(), money = z.number().int().positive().max(2_000_000_000)
const record = z.object({ businessDate: date, amountSen: money, description: z.string().trim().min(1).max(400), confirmedCouponSale: z.literal(true), salesAlreadyRecorded: z.literal(true) }).strict()
const priorCollection = z.object({ receivedDate: date, amountSen: money, description: z.string().trim().min(1).max(400), confirmedAlreadyReceived: z.literal(true), includedInSales: z.boolean().nullable().default(null), sourceClaimDate: date.nullable().default(null), receiptKey: z.string().regex(/^R-[A-F0-9]{6}$/).optional() }).strict()
const collect = z.object({ claimId: z.uuid(), receivedDate: date, amountSen: money, confirmedAlreadyReceived: z.literal(true), receiptKey: z.string().regex(/^R-[A-F0-9]{6}$/).optional() }).strict()
/** Cash timing of coupon sales already in revenue. Never a second sale or expense. */
export async function agentCouponRoutes(app: FastifyInstance) {
 const owner = { preHandler: requireAgent('OWNER') }
 app.get('/agent/coupon-claims', owner, async r => ({ claims: await r.db.reconciliationCase.findMany({ where: { kind: { in: ['COUPON_RECEIVABLE', 'COUPON_PRIOR_COLLECTION'] } }, orderBy: { createdAt: 'desc' }, take: 100 }) }))
 async function refresh(tx: any, businessId: string, days: string[]) {
  const results = []
  for (const day of new Set(days)) {
   const closing = await tx.reconciliationCase.findFirst({ where: { key: `closing:${day}`, kind: 'DAILY_CLOSING' } })
   if (closing) results.push(await refreshClosing(tx, businessId, closing.detail.input, closing.detail.evidence))
  }
  return results
 }
 app.post('/agent/coupon-claims', owner, async r => {
  const b = record.parse(r.body)
  return r.db.$transaction(async tx => {
   const key = `coupon-receivable:${b.businessDate}`
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':' + key}))::text`
   const prior = await tx.reconciliationCase.findFirst({ where: { key } })
   if (prior) {
    if ((prior.detail as any).amountSen !== b.amountSen) throw conflict('agent:COUPON_TOTAL_ALREADY_RECORDED', 'This day already has a coupon total; review it instead of adding another.')
    return { saved: true, replayed: true, claim: prior, closings: await refresh(tx, r.businessId, [b.businessDate]) }
   }
   await assertNotLocked(tx, b.businessDate)
   const sales = await tx.ledgerEntry.findMany({ where: { businessDate: toDate(b.businessDate), category: { in: ['REVENUE', 'REFUND'] } } })
   const net = sales.reduce((n, e) => n + (e.direction === 'MONEY_IN' ? e.amountSen : -e.amountSen), 0)
   if (net < b.amountSen) throw conflict('agent:COUPON_EXCEEDS_RECORDED_SALES')
   const entry = await tx.ledgerEntry.create({ data: { businessId: r.businessId, businessDate: toDate(b.businessDate), amountSen: b.amountSen, direction: 'MONEY_OUT', category: 'RECONCILIATION_ADJUSTMENT', description: `Coupon receivable · ${b.businessDate} · Non-cash sales reclassification, NOT a bank payment · ${b.description}` } })
   const claim = await tx.reconciliationCase.create({ data: { businessId: r.businessId, key, kind: 'COUPON_RECEIVABLE', status: 'OPEN', detail: { ...b, outstandingSen: b.amountSen, paymentStatus: 'UNPAID', evidenceStatus: 'OWNER_DECLARED', receivableLedgerId: entry.id.toString(), note: 'Existing sales are preserved. Cash-book adjustment defers the non-cash coupon amount to a receivable; it is not an expense or actual bank withdrawal. A later collection requires its actual received date.' } } })
   await tx.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'coupon.receivable.recorded', entityType: 'coupon', entityId: claim.id, detail: b } })
   return { saved: true, replayed: false, claim, closings: await refresh(tx, r.businessId, [b.businessDate]) }
  })
 })
 app.post('/agent/coupon-claims/prior-collection', owner, async r => {
  const b = priorCollection.parse(r.body)
  if (b.sourceClaimDate && b.sourceClaimDate >= b.receivedDate) throw conflict('agent:PRIOR_COUPON_DATE_MISMATCH')
  return r.db.$transaction(async tx => {
   const key = `coupon-prior-collection:${b.receivedDate}`
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':' + key}))::text`
   const prior = await tx.reconciliationCase.findFirst({ where: { key } })
   const d = (prior?.detail ?? {}) as any
   const included = b.includedInSales ?? d.includedInSales ?? null
   if (prior && (d.amountSen !== b.amountSen || (d.includedInSales !== null && included !== d.includedInSales))) throw conflict('agent:PRIOR_COUPON_ALREADY_RECORDED', 'Review the existing received claim rather than duplicating or changing an already classified collection.')
   await assertNotLocked(tx, b.receivedDate)
   let evidenceIdentity: string | null = d.evidenceIdentity ?? null
   if (b.receiptKey) {
    const evidence = await tx.chopperStash.findFirst({ where: { receiptKey: b.receiptKey } })
    const data = evidence?.data as any
    if (!data?.fileId || !data.scanVerified || data.reading?.date !== b.receivedDate || data.reading?.totalSen !== b.amountSen || data.transferDirection === 'MONEY_OUT') throw conflict('agent:COUPON_EVIDENCE_MISMATCH')
    evidenceIdentity = data.scanHash || data.fileId
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':coupon-evidence:' + evidenceIdentity}))::text`
    if (await tx.reconciliationCase.findFirst({ where: { ...(prior ? { id: { not: prior.id } } : {}), kind: { in: ['COUPON_RECEIVABLE', 'COUPON_PRIOR_COLLECTION'] }, detail: { path: ['evidenceIdentity'], equals: evidenceIdentity! } } })) throw conflict('agent:COUPON_EVIDENCE_ALREADY_USED')
   }
   let collectionLedgerId = d.collectionLedgerId ?? null
   if (included === false && !collectionLedgerId) {
    const entry = await tx.ledgerEntry.create({ data: { businessId: r.businessId, businessDate: toDate(b.receivedDate), amountSen: b.amountSen, direction: 'MONEY_IN', category: 'RECONCILIATION_ADJUSTMENT', description: `Prior coupon collection · ${b.receivedDate} · Older claim received, NOT new sales · ${b.description}` } })
    collectionLedgerId = entry.id.toString()
   }
   const detail = { ...d, ...b, includedInSales: included, sourceClaimDate: b.sourceClaimDate ?? d.sourceClaimDate ?? null, collectionLedgerId,
    paymentStatus: 'RECEIVED', outstandingSen: 0, evidenceIdentity,
    evidenceStatus: (b.receiptKey || d.receiptKey) ? 'ATTACHED' : 'AWAITING_PAYMENT_EVIDENCE',
    ...(d.receiptKey && !b.receiptKey ? { receiptKey: d.receiptKey } : {}),
    classificationStatus: included === null ? 'AWAITING_SALES_INCLUSION' : 'CLASSIFIED',
    note: 'Owner confirms actual receipt of an older coupon claim. Original sale date is not invented. If already included in declared sales, no additional cash or sale is posted. If inclusion is unknown, confirmation is saved pending classification without a cash-book entry. A separate receipt is posted once only when confirmed additional to sales.' }
   const claim = await tx.reconciliationCase.upsert({ where: { businessId_key: { businessId: r.businessId, key } },
    create: { businessId: r.businessId, key, kind: 'COUPON_PRIOR_COLLECTION', status: 'OPEN', detail }, update: { detail } })
   if (!prior || JSON.stringify(d) !== JSON.stringify(detail)) await tx.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'coupon.prior-collection.recorded', entityType: 'coupon', entityId: claim.id, detail: { before: d, after: detail } } })
   return { saved: true, replayed: Boolean(prior), claim, cashBookPosted: Boolean(collectionLedgerId), closings: await refresh(tx, r.businessId, [b.receivedDate]) }
  })
 })
 app.post('/agent/coupon-claims/collect', owner, async r => {
  const b = collect.parse(r.body)
  return r.db.$transaction(async tx => {
   await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':coupon-collection:' + b.claimId}))::text`
   const prior = await tx.reconciliationCase.findFirst({ where: { id: b.claimId, kind: 'COUPON_RECEIVABLE' } })
   if (!prior) throw notFound('agent:COUPON_CLAIM_NOT_FOUND')
   const d = prior.detail as any
   if (b.amountSen !== d.amountSen || b.receivedDate < d.businessDate) throw conflict('agent:COUPON_COLLECTION_MISMATCH', 'Use the actual received date and full outstanding claim amount.')
   if (d.paymentStatus === 'RECEIVED' && d.receivedDate !== b.receivedDate) throw conflict('agent:COUPON_COLLECTION_ALREADY_RECORDED')
   await assertNotLocked(tx, b.receivedDate)
   let evidenceIdentity: string | null = null
   if (b.receiptKey) {
    const evidence = await tx.chopperStash.findFirst({ where: { receiptKey: b.receiptKey } })
    const data = evidence?.data as any
    if (!data?.fileId || !data.scanVerified || data.reading?.date !== b.receivedDate || data.reading?.totalSen !== b.amountSen || data.transferDirection === 'MONEY_OUT') throw conflict('agent:COUPON_EVIDENCE_MISMATCH')
    evidenceIdentity = data.scanHash || data.fileId
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':coupon-evidence:' + evidenceIdentity}))::text`
    if (await tx.reconciliationCase.findFirst({ where: { id: { not: prior.id }, kind: { in: ['COUPON_RECEIVABLE', 'COUPON_PRIOR_COLLECTION'] }, detail: { path: ['evidenceIdentity'], equals: evidenceIdentity! } } })) throw conflict('agent:COUPON_EVIDENCE_ALREADY_USED')
   }
   if (d.paymentStatus === 'RECEIVED') {
    let claim = prior
    if (b.receiptKey && d.evidenceStatus !== 'ATTACHED') {
     claim = await tx.reconciliationCase.update({ where: { id: prior.id }, data: { detail: { ...d, receiptKey: b.receiptKey, evidenceIdentity, evidenceStatus: 'ATTACHED' } } })
     await tx.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'coupon.collection.evidence.attached', entityType: 'coupon', entityId: claim.id, detail: b } })
    }
    return { saved: true, replayed: true, claim, closings: await refresh(tx, r.businessId, [d.businessDate, b.receivedDate]) }
   }
   const entry = await tx.ledgerEntry.create({ data: { businessId: r.businessId, businessDate: toDate(b.receivedDate), amountSen: b.amountSen, direction: 'MONEY_IN', category: 'RECONCILIATION_ADJUSTMENT', description: `Coupon collection · ${d.businessDate} · Settlement of existing coupon receivable, NOT new sales` } })
   const claim = await tx.reconciliationCase.update({ where: { id: prior.id }, data: { status: 'RESOLVED', resolution: 'Owner confirmed coupon claim received.', detail: { ...d, ...b, outstandingSen: 0, paymentStatus: 'RECEIVED', evidenceStatus: b.receiptKey ? 'ATTACHED' : 'AWAITING_PAYMENT_EVIDENCE', evidenceIdentity, collectionLedgerId: entry.id.toString() } } })
   await tx.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'coupon.collection.recorded', entityType: 'coupon', entityId: claim.id, detail: b } })
   return { saved: true, replayed: false, claim, closings: await refresh(tx, r.businessId, [d.businessDate, b.receivedDate]) }
  })
 })
}
