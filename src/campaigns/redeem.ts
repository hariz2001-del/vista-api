import { z } from 'zod'
import { configColumns, lineArtwork } from './artwork.ts'
import { sheetSaysPaid } from './writeback.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc } from '../domain/business-date.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

/**
 * Campaign coupons at the till.
 *
 * The customer already paid for what a coupon gives, and that money was booked
 * when the owner verified the payment. So at the till a coupon only takes money
 * OFF the sale, as ordinary line discounts the checkout already understands:
 *  - a prepaid item rings up at its menu price, fully discounted (RM0), so stock
 *    and item sales still count it;
 *  - a voucher takes up to its value off eligible items, never below zero.
 * The redemption row ties the coupon to the sale, written in the sale's own
 * transaction: a failed or abandoned sale uses up nothing.
 */

export const redemptionSchema = z.object({
  code: z.string().trim().min(3).max(40),
  benefits: z
    .array(
      z.object({
        benefit_id: z.string().uuid(),
        /** The cart line it is applied to; null for a prepaid item handed over without a till line. */
        line_index: z.number().int().min(0).nullable(),
        amount_sen: z.number().int().min(0),
      }),
    )
    .max(10),
})
export type RedemptionInput = z.infer<typeof redemptionSchema>

export const normaliseCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '')

type CouponLookup = Awaited<ReturnType<typeof findCoupon>>

async function findCoupon(tx: Tx, code: string) {
  return tx.campaignCoupon.findFirst({
    where: { code: { equals: normaliseCode(code), mode: 'insensitive' } },
    include: {
      campaign: { include: { benefits: { orderBy: { sortOrder: 'asc' } } } },
      order: true,
      orderLine: true,
      redemptions: { where: { status: 'COMPLETED' } },
    },
  })
}

/** Why a coupon cannot be used right now, as an error code; null when it can. */
function refusal(coupon: NonNullable<CouponLookup>): string | null {
  if (coupon.order.deletedAt) return 'coupon:NOT_FOUND'
  if (coupon.order.verification === 'REJECTED') return 'coupon:REJECTED'
  if (coupon.order.verification !== 'VERIFIED') {
    return sheetSaysPaid(coupon.order.sourceStatus, coupon.order.verification, coupon.campaign.sourceConfig) ? 'coupon:VERIFY_IN_VISTA' : 'coupon:NOT_PAID'
  }
  if (coupon.campaign.status !== 'ACTIVE') return 'coupon:CAMPAIGN_CLOSED'
  if (coupon.redemptions.length > 0) return 'coupon:USED'
  return null
}

function benefitsFor(coupon: NonNullable<CouponLookup>, businessDate: string) {
  const day = businessDateToUtc(businessDate).getTime()
  return coupon.campaign.benefits.filter(
    (benefit) =>
      (benefit.campaignProductId === null || benefit.campaignProductId === coupon.orderLine?.campaignProductId) &&
      (!benefit.expiresOn || benefit.expiresOn.getTime() >= day),
  )
}

/** Why a coupon cannot be used on this business date; null when it can. */
function problemOn(coupon: NonNullable<CouponLookup>, businessDate: string): string | null {
  const reason = refusal(coupon)
  if (reason) return reason
  if (benefitsFor(coupon, businessDate).length === 0 && coupon.campaign.benefits.length > 0) return 'coupon:EXPIRED'
  return null
}

/** What the till shows when a code is typed in. Throws the reason it cannot be used. */
export async function lookupCoupon(tx: Tx, code: string, businessDate: string) {
  const coupon = await findCoupon(tx, code)
  if (!coupon) throw notFound('coupon:NOT_FOUND')
  const reason = problemOn(coupon, businessDate)
  if (reason) throw reason === 'coupon:NOT_FOUND' ? notFound(reason) : conflict(reason)
  const benefits = benefitsFor(coupon, businessDate)
  const columns = configColumns(coupon.campaign.sourceConfig)
  const productIds = benefits.flatMap((benefit) => (benefit.productId ? [benefit.productId] : []))
  const products = productIds.length
    ? await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, basePriceSen: true } })
    : []
  return {
    code: coupon.code,
    campaign: { id: coupon.campaign.id, name: coupon.campaign.name },
    order: {
      ref: coupon.order.externalRef,
      customerName: coupon.order.customerName,
      phone: coupon.order.contact,
      item: coupon.orderLine?.label ?? null,
      /** The set's design preview can be shown (GET /pos/coupons/:code/design). */
      hasDesign: !!coupon.orderLine && lineArtwork(coupon.orderLine.details, columns).designFileId !== null,
    },
    benefits: benefits.map((benefit) => {
      const product = products.find((row) => row.id === benefit.productId)
      return {
        id: benefit.id,
        kind: benefit.kind,
        label: benefit.label,
        valueSen: benefit.valueSen,
        productId: benefit.productId,
        productName: product?.name ?? null,
        productPriceSen: product?.basePriceSen ?? null,
        categoryIds: benefit.categoryIds,
      }
    }),
  }
}

/**
 * The part every coupon of a campaign starts with ("SIB-"), so the till can
 * fill it in and staff only key in the rest. Empty when they do not share one.
 */
export function codePrefix(codes: string[]): string {
  if (codes.length === 0) return ''
  let prefix = codes[0]!.toUpperCase()
  for (const code of codes) {
    const upper = code.toUpperCase()
    let i = 0
    while (i < prefix.length && i < upper.length && prefix[i] === upper[i]) i++
    prefix = prefix.slice(0, i)
  }
  // Stop at the last separator, so no part of the unique bit is pre-filled.
  const cut = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'))
  return cut >= 1 ? prefix.slice(0, cut + 1) : ''
}

/**
 * Malaysian numbers as people write them: "012-345 6789", "+60 12 345 6789",
 * a wa.me link. Compared without the country code or the leading 0.
 */
export function phoneKey(text: string | null): string {
  let digits = (text ?? '').replace(/\D/g, '')
  if (digits.startsWith('60')) digits = digits.slice(2)
  return digits.replace(/^0+/, '')
}

const codeKey = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** The campaigns running now, for the till's Campaign button. */
export async function activeCampaigns(tx: Tx, businessId: string) {
  const campaigns = await tx.campaign.findMany({
    where: { businessId, status: 'ACTIVE', archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, coupons: { select: { code: true } } },
  })
  return campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, codePrefix: codePrefix(campaign.coupons.map((c) => c.code)) }))
}

/**
 * A campaign's coupons found by the customer's phone number or by the code
 * without its prefix — for a customer who did not keep the QR. Exact matches
 * only (never "starts with"), so nobody can browse the customer list. Each row
 * says why it cannot be used, if it cannot; staff then pick one to confirm.
 */
export async function findCampaignCoupons(
  tx: Tx,
  input: { businessId: string; campaignId: string; businessDate: string; phone?: string; code?: string },
) {
  const campaign = await tx.campaign.findFirst({ where: { id: input.campaignId, businessId: input.businessId }, select: { id: true } })
  if (!campaign) throw notFound('campaign:NOT_FOUND')
  const phone = input.phone === undefined ? null : phoneKey(input.phone)
  if (phone !== null && phone.length < 8) throw badRequest('coupon:PHONE_TOO_SHORT')
  const typed = input.code === undefined ? null : codeKey(input.code)
  if (typed !== null && typed.length < 3) throw badRequest('coupon:CODE_TOO_SHORT')

  const coupons = await tx.campaignCoupon.findMany({
    where: { campaignId: campaign.id, order: { deletedAt: null } },
    include: {
      campaign: { include: { benefits: { orderBy: { sortOrder: 'asc' } } } },
      order: true,
      orderLine: true,
      redemptions: { where: { status: 'COMPLETED' } },
    },
    orderBy: { code: 'asc' },
  })
  const prefix = codeKey(codePrefix(coupons.map((coupon) => coupon.code)))
  const matches = coupons.filter((coupon) => {
    if (phone !== null) return phoneKey(coupon.order.contact) === phone
    const key = codeKey(coupon.code)
    return key === typed || key === prefix + typed
  })
  return matches.map((coupon) => ({
    code: coupon.code,
    customerName: coupon.order.customerName,
    phone: coupon.order.contact,
    orderRef: coupon.order.externalRef,
    item: coupon.orderLine?.label ?? null,
    /** An error code (coupon:USED, coupon:NOT_PAID…) when it cannot be used now. */
    problem: problemOn(coupon, input.businessDate),
  }))
}

/** The design preview file of the set a coupon is for, or null. */
export async function couponDesignFile(tx: Tx, code: string) {
  const coupon = await findCoupon(tx, code)
  if (!coupon || coupon.order.deletedAt || !coupon.orderLine) return null
  const fileId = lineArtwork(coupon.orderLine.details, configColumns(coupon.campaign.sourceConfig)).designFileId
  return fileId ? { campaign: coupon.campaign, fileId } : null
}

type Line = { productId: string; categoryId: string; quantity: number; unitPriceSen: number; grossSen: number; lineDiscountSen: number }

/**
 * Record the coupons used on a sale, inside the checkout transaction.
 *
 * Online, anything wrong refuses the whole sale (the cashier removes the
 * coupon and charges normally). For a sale synced from offline the money has
 * already changed hands, so a coupon problem never blocks the sale: the
 * redemption is skipped and the sale is marked for the owner to review.
 */
export async function redeemCoupons(
  tx: Tx,
  input: {
    businessId: string
    posOrderId: string
    clientTxnId: string
    businessDate: string
    offlineSync: boolean
    redemptions: RedemptionInput[]
    lines: Line[]
  },
): Promise<{ problems: string[] }> {
  const problems: string[] = []
  const seen = new Set<string>()
  const usedOnLine = new Map<number, number>()

  for (const redemption of input.redemptions) {
    const code = normaliseCode(redemption.code)
    try {
      if (seen.has(code)) throw badRequest('coupon:MISMATCH', 'the same coupon twice on one sale')
      seen.add(code)
      // One till at a time per coupon: the second waits, then sees it used.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.businessId + ':campaign-coupon:' + code}))`
      const coupon = await findCoupon(tx, code)
      if (!coupon) throw notFound('coupon:NOT_FOUND')
      const reason = refusal(coupon)
      if (reason) throw conflict(reason)
      const allowed = new Map(benefitsFor(coupon, input.businessDate).map((benefit) => [benefit.id, benefit]))

      const applied: Array<{ benefitId: string; kind: string; label: string; amountSen: number; productId: string | null; lineIndex: number | null }> = []
      let prepaidSen = 0
      let voucherSen = 0
      const usedBenefits = new Set<string>()
      for (const use of redemption.benefits) {
        const benefit = allowed.get(use.benefit_id)
        if (!benefit) throw badRequest('coupon:MISMATCH', 'a benefit this coupon does not give, or it expired')
        if (usedBenefits.has(benefit.id)) throw badRequest('coupon:MISMATCH', 'a benefit used twice')
        usedBenefits.add(benefit.id)

        if (use.line_index === null) {
          // Handed over without a till line: only a prepaid item with no menu item.
          if (benefit.kind !== 'PREPAID_PRODUCT' || benefit.productId || use.amount_sen !== 0) throw badRequest('coupon:MISMATCH', 'a benefit needs its till line')
          applied.push({ benefitId: benefit.id, kind: benefit.kind, label: benefit.label, amountSen: 0, productId: null, lineIndex: null })
          prepaidSen += benefit.valueSen
          continue
        }
        const line = input.lines[use.line_index]
        if (!line) throw badRequest('coupon:MISMATCH', 'no such line')
        if (benefit.kind === 'PREPAID_PRODUCT') {
          // One unit of the prepaid item, fully free.
          if (benefit.productId && line.productId !== benefit.productId) throw badRequest('coupon:MISMATCH', 'prepaid item on the wrong line')
          if (use.amount_sen !== line.unitPriceSen) throw badRequest('coupon:MISMATCH', 'a prepaid item comes off at its full price')
          prepaidSen += use.amount_sen
        } else {
          if (benefit.productId && line.productId !== benefit.productId) throw badRequest('coupon:MISMATCH', 'voucher not valid on that item')
          if (benefit.categoryIds.length && !benefit.categoryIds.includes(line.categoryId)) throw badRequest('coupon:MISMATCH', 'voucher not valid on that item')
          if (use.amount_sen === 0 || use.amount_sen > benefit.valueSen) throw badRequest('coupon:MISMATCH', 'voucher amount over its value')
          voucherSen += use.amount_sen
        }
        // What coupons take off a line must be within that line's own discount.
        const onLine = (usedOnLine.get(use.line_index) ?? 0) + use.amount_sen
        if (onLine > line.lineDiscountSen || onLine > line.grossSen) throw badRequest('coupon:MISMATCH', 'coupon amount not on the bill')
        usedOnLine.set(use.line_index, onLine)
        applied.push({ benefitId: benefit.id, kind: benefit.kind, label: benefit.label, amountSen: use.amount_sen, productId: line.productId, lineIndex: use.line_index })
      }

      await tx.campaignRedemption.create({
        data: {
          businessId: input.businessId,
          couponId: coupon.id,
          campaignOrderId: coupon.orderId,
          posOrderId: input.posOrderId,
          clientTxnId: input.clientTxnId,
          applied,
          prepaidSen,
          voucherSen,
        },
      })
      // The sheet's "voucher redeemed" tick follows on the next sync.
      await tx.campaignOrder.update({ where: { id: coupon.orderId }, data: { sheetDirty: true } })
      await tx.campaignAuditEntry.create({
        data: {
          businessId: input.businessId,
          campaignId: coupon.campaignId,
          orderId: coupon.orderId,
          actorKind: 'STAFF',
          actorLabel: 'Counter',
          action: 'coupon.redeem',
          after: { code: coupon.code, posOrderId: input.posOrderId, prepaidSen, voucherSen },
        },
      })
    } catch (caught) {
      if (!input.offlineSync) throw caught
      problems.push(`${code}: ${caught instanceof Error ? caught.message : 'not redeemed'}`)
    }
  }
  return { problems }
}

/** A cancelled sale gives its coupons back. */
export async function releaseCoupons(tx: Tx, businessId: string, posOrderId: string, reason: string): Promise<number> {
  const live = await tx.campaignRedemption.findMany({ where: { posOrderId, status: 'COMPLETED' }, include: { coupon: true } })
  for (const redemption of live) {
    await tx.campaignRedemption.update({ where: { id: redemption.id }, data: { status: 'REVERSED', reversedAt: new Date() } })
    await tx.campaignOrder.update({ where: { id: redemption.campaignOrderId }, data: { sheetDirty: true } })
    await tx.campaignAuditEntry.create({
      data: {
        businessId,
        campaignId: redemption.coupon.campaignId,
        orderId: redemption.campaignOrderId,
        actorKind: 'STAFF',
        actorLabel: 'Counter',
        action: 'coupon.release',
        after: { code: redemption.coupon.code, posOrderId, reason },
      },
    })
  }
  return live.length
}
