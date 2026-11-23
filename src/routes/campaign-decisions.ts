import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import { campaignActor, campaignAudit } from '../campaigns/audit.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc, businessToday } from '../domain/business-date.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { refreshClosing } from './agent-closing.ts'
import { pushSoon } from '../campaigns/writeback.ts'
import { assertNotLocked } from './rms.ts'

/**
 * The owner's decision on a campaign payment, and what it does to the books.
 *
 *  - Verify: one REVENUE line, money in, dated the day the customer PAID
 *    (not the day it was checked), to the campaign's brand. The order keeps
 *    that line's id, which is unique, so it can never be booked twice.
 *  - Undo a verification: a REFUND line on the same date for the same amount.
 *    The first line is never edited or deleted. Refused once a coupon from the
 *    order has been used at the till.
 *  - Reject / reopen: no money moves.
 *  - Delete: a soft delete, only for orders that never reached the books.
 *
 * Every step is on the campaign's audit trail with who did it and when.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const verifyBody = z.object({
  /** The business date the customer paid on. Required: never guessed. */
  paymentDate: DATE,
  /** What was actually paid, if the owner corrected it; else the order's expected amount. */
  paidSen: z.number().int().positive().max(100_000_000).optional(),
  paymentRef: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
})
const noteBody = z.object({ note: z.string().trim().max(500).nullish() })
const undoBody = z.object({ note: z.string().trim().min(3).max(500) })
const bulkBody = z.object({
  action: z.enum(['reject', 'dismiss', 'delete', 'restore']),
  ids: z.array(ID).min(1).max(500),
  note: z.string().trim().max(500).nullish(),
})

type OrderParams = { Params: { id: string; orderId: string } }
type Params = { Params: { id: string } }

const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)

async function lockOrder(tx: Tx, businessId: string, orderId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':campaign-order:' + orderId}))`
}

async function loadOrder(tx: Tx, campaignId: string, orderId: string) {
  const order = await tx.campaignOrder.findFirst({ where: { id: orderId, campaignId }, include: { campaign: true } })
  if (!order) throw notFound('campaign:ORDER_NOT_FOUND')
  return order
}

/** The day's closing, if one exists, recomputed so it includes the change. */
async function refreshDay(tx: Tx, businessId: string, day: string) {
  const closing = await tx.reconciliationCase.findFirst({ where: { key: `closing:${day}`, kind: 'DAILY_CLOSING' } })
  if (closing) {
    const detail = closing.detail as { input: Parameters<typeof refreshClosing>[2]; evidence?: Record<string, string> }
    await refreshClosing(tx, businessId, detail.input, detail.evidence ?? {})
  }
}

async function hasRedemption(tx: Tx, orderId: string) {
  return (await tx.campaignRedemption.count({ where: { campaignOrderId: orderId, status: 'COMPLETED' } })) > 0
}

function decided(request: FastifyRequest) {
  const actor = campaignActor(request)
  return { decidedById: actor.id, decidedByLabel: actor.label, decidedAt: new Date() }
}

export async function campaignDecisionRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }

  app.post<OrderParams>('/rms/campaigns/:id/orders/:orderId/verify', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const body = verifyBody.parse(request.body)
    const outcome = await request.db.$transaction(async (tx) => {
      await lockOrder(tx, request.businessId, orderId)
      const order = await loadOrder(tx, campaignId, orderId)
      if (order.deletedAt) throw notFound('campaign:ORDER_NOT_FOUND')
      const amountSen = body.paidSen ?? order.expectedSen
      if (order.verification === 'VERIFIED') {
        // A repeated click: the same decision again is fine and books nothing.
        if (iso(order.paymentDate) === body.paymentDate && (order.paidSen ?? order.expectedSen) === amountSen) {
          return { orderId, verification: order.verification, ledgerEntryId: order.ledgerEntryId?.toString() ?? null, repeated: true }
        }
        throw conflict('campaign:ORDER_DECIDED')
      }
      if (order.verification === 'REJECTED') throw conflict('campaign:ORDER_DECIDED')
      if (amountSen <= 0) throw badRequest('validation:INVALID_REQUEST', 'nothing to book')

      const today = await businessToday(tx, request.businessId)
      if (body.paymentDate > today) throw badRequest('campaign:PAYMENT_DATE_FUTURE')
      await assertNotLocked(tx, body.paymentDate)

      const entry = await tx.ledgerEntry.create({
        data: {
          businessId: request.businessId,
          businessDate: businessDateToUtc(body.paymentDate),
          direction: 'MONEY_IN',
          amountSen,
          category: 'REVENUE',
          description: `${order.campaign.name} pre-order ${order.externalRef}`.slice(0, 200),
          brandId: order.campaign.brandId,
        },
      })
      await tx.campaignOrder.update({
        where: { id: orderId },
        data: {
          verification: 'VERIFIED',
          paymentDate: businessDateToUtc(body.paymentDate),
          paidSen: amountSen,
          paymentRef: body.paymentRef ?? order.paymentRef,
          reviewNote: body.note ?? null,
          ledgerEntryId: entry.id,
          reversalEntryId: null,
          sheetDirty: true,
          ...decided(request),
        },
      })
      await campaignAudit(tx, request.businessId, campaignActor(request), {
        campaignId,
        orderId,
        action: 'order.verify',
        before: { verification: order.verification },
        after: { paymentDate: body.paymentDate, amountSen, paymentRef: body.paymentRef ?? null, ledgerEntryId: entry.id, note: body.note ?? null },
      })
      await refreshDay(tx, request.businessId, body.paymentDate)
      return { orderId, verification: 'VERIFIED', ledgerEntryId: entry.id.toString(), repeated: false }
    })
    await pushSoon(request.db, campaignId)
    return outcome
  })

  app.post<OrderParams>('/rms/campaigns/:id/orders/:orderId/reject', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const body = noteBody.parse(request.body ?? {})
    const outcome = await request.db.$transaction(async (tx) => {
      await lockOrder(tx, request.businessId, orderId)
      const order = await loadOrder(tx, campaignId, orderId)
      if (order.verification === 'REJECTED') return { orderId, verification: 'REJECTED', repeated: true }
      if (order.verification !== 'UNVERIFIED') throw conflict('campaign:ORDER_DECIDED')
      await tx.campaignOrder.update({ where: { id: orderId }, data: { verification: 'REJECTED', reviewNote: body.note ?? null, sheetDirty: true, ...decided(request) } })
      await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'order.reject', after: { note: body.note ?? null } })
      return { orderId, verification: 'REJECTED', repeated: false }
    })
    await pushSoon(request.db, campaignId)
    return outcome
  })

  /** Back to unverified after a rejection. No money involved. */
  app.post<OrderParams>('/rms/campaigns/:id/orders/:orderId/reopen', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const body = noteBody.parse(request.body ?? {})
    const outcome = await request.db.$transaction(async (tx) => {
      await lockOrder(tx, request.businessId, orderId)
      const order = await loadOrder(tx, campaignId, orderId)
      if (order.verification !== 'REJECTED') throw conflict('campaign:ORDER_DECIDED')
      await tx.campaignOrder.update({ where: { id: orderId }, data: { verification: 'UNVERIFIED', reviewNote: body.note ?? null, sheetDirty: true, ...decided(request) } })
      await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'order.reopen', after: { note: body.note ?? null } })
      return { orderId, verification: 'UNVERIFIED' }
    })
    await pushSoon(request.db, campaignId)
    return outcome
  })

  /** Undo a verification: a REFUND line reverses the revenue on the same date. */
  app.post<OrderParams>('/rms/campaigns/:id/orders/:orderId/unverify', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const body = undoBody.parse(request.body)
    const outcome = await request.db.$transaction(async (tx) => {
      await lockOrder(tx, request.businessId, orderId)
      const order = await loadOrder(tx, campaignId, orderId)
      if (order.verification !== 'VERIFIED' || !order.ledgerEntryId || !order.paymentDate) throw conflict('campaign:ORDER_NOT_VERIFIED')
      if (await hasRedemption(tx, orderId)) throw conflict('campaign:ORDER_REDEEMED')
      const day = iso(order.paymentDate)!
      await assertNotLocked(tx, day)
      const original = await tx.ledgerEntry.findUniqueOrThrow({ where: { id: order.ledgerEntryId } })
      const reversal = await tx.ledgerEntry.create({
        data: {
          businessId: request.businessId,
          businessDate: original.businessDate,
          direction: 'MONEY_OUT',
          amountSen: original.amountSen,
          category: 'REFUND',
          description: `Reversal: ${original.description}`.slice(0, 200),
          brandId: original.brandId,
        },
      })
      await tx.campaignOrder.update({
        where: { id: orderId },
        data: { verification: 'UNVERIFIED', ledgerEntryId: null, reversalEntryId: null, reviewNote: body.note, sheetDirty: true, ...decided(request) },
      })
      await campaignAudit(tx, request.businessId, campaignActor(request), {
        campaignId,
        orderId,
        action: 'order.unverify',
        before: { verification: 'VERIFIED', ledgerEntryId: original.id, paymentDate: day, amountSen: original.amountSen },
        after: { reversalEntryId: reversal.id, note: body.note },
      })
      await refreshDay(tx, request.businessId, day)
      return { orderId, verification: 'UNVERIFIED', reversalEntryId: reversal.id.toString() }
    })
    await pushSoon(request.db, campaignId)
    return outcome
  })

  /**
   * Many orders at once. Each order is handled on its own and either done or
   * skipped with a reason; nothing financial is ever deleted or reversed here.
   */
  app.post<Params>('/rms/campaigns/:id/orders/bulk', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const body = bulkBody.parse(request.body)
    const done: string[] = []
    const skipped: Array<{ id: string; ref: string | null; reason: string }> = []
    for (const orderId of new Set(body.ids)) {
      try {
        await request.db.$transaction(async (tx) => {
          await lockOrder(tx, request.businessId, orderId)
          const order = await loadOrder(tx, campaignId, orderId)
          const skip = (reason: string) => {
            skipped.push({ id: orderId, ref: order.externalRef, reason })
          }
          if (body.action === 'reject') {
            if (order.deletedAt) return skip('deleted')
            if (order.verification !== 'UNVERIFIED') return skip(order.verification === 'VERIFIED' ? 'verified: undo it on its own first' : 'already rejected')
            await tx.campaignOrder.update({ where: { id: orderId }, data: { verification: 'REJECTED', reviewNote: body.note ?? null, sheetDirty: true, ...decided(request) } })
            await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'order.reject', after: { bulk: true, note: body.note ?? null } })
          } else if (body.action === 'dismiss') {
            const proof = await tx.campaignPaymentProof.findFirst({ where: { orderId } })
            if (!proof || proof.flags.every((flag) => flag === 'PASSED') || proof.dismissedAt) return skip('no open flags')
            await tx.campaignPaymentProof.update({ where: { id: proof.id }, data: { dismissedAt: new Date() } })
            await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'proof.dismiss', before: { flags: proof.flags }, after: { bulk: true } })
          } else if (body.action === 'delete') {
            if (order.deletedAt) return skip('already deleted')
            if (order.verification === 'VERIFIED' || order.ledgerEntryId) return skip('verified: part of the books')
            if (await hasRedemption(tx, orderId)) return skip('a coupon was used at the till')
            await tx.campaignOrder.update({ where: { id: orderId }, data: { deletedAt: new Date() } })
            await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'order.delete', after: { bulk: true, note: body.note ?? null } })
          } else {
            if (!order.deletedAt) return skip('not deleted')
            await tx.campaignOrder.update({ where: { id: orderId }, data: { deletedAt: null } })
            await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'order.restore', after: { bulk: true } })
          }
          done.push(orderId)
        })
      } catch (caught) {
        skipped.push({ id: orderId, ref: null, reason: caught instanceof Error && 'statusCode' in caught && (caught as { statusCode: number }).statusCode === 404 ? 'not found' : 'could not be changed' })
      }
    }
    if (body.action === 'reject' && done.length) await pushSoon(request.db, campaignId)
    return { done, skipped }
  })
}

