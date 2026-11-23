import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent, requireOwner } from '../auth.ts'
import { configColumns, configStyles, lineArtwork } from '../campaigns/artwork.ts'
import { campaignActor } from '../campaigns/audit.ts'
import { readDriveFile } from '../campaigns/google.ts'
import { sourceCredentials, syncCampaign } from '../campaigns/sync.ts'
import { sheetSaysPaid } from '../campaigns/writeback.ts'
import type { Tx } from '../db.ts'
import { badRequest, notFound } from '../errors.ts'

/**
 * A campaign's orders: bring them in, list them, open one, see its proof.
 * Owner only, apart from Hermes's scheduled sync.
 */

const ID = z.string().uuid()
const FLAGS = ['PASSED', 'FLAGGED', 'POSSIBLE_DUPLICATE', 'AMOUNT_MISMATCH', 'INVALID_IMAGE', 'UNREADABLE'] as const

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  verification: z.enum(['UNVERIFIED', 'VERIFIED', 'REJECTED']).optional(),
  /** NEEDS_ATTENTION: undecided with an open reader flag. */
  flag: z.enum([...FLAGS, 'NEEDS_ATTENTION', 'UNREAD']).optional(),
  redeemed: z.enum(['yes', 'no']).optional(),
  /** yes: every coupon used, or the sheet says Collected. no: something still to hand over. */
  collected: z.enum(['yes', 'no']).optional(),
  /** The pickup date and slot exactly as the source writes them ("Mon 23 Nov"). */
  pickupDate: z.string().trim().max(80).optional(),
  pickupSlot: z.string().trim().max(120).optional(),
  sort: z.enum(['submittedAt', 'customerName', 'expectedSen', 'externalRef', 'verification', 'pickup']).default('submittedAt'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  /** no: hide deleted; only: just the deleted ones; yes: both. */
  includeDeleted: z.enum(['yes', 'no', 'only']).default('no'),
})

type Params = { Params: { id: string } }
type OrderParams = { Params: { id: string; orderId: string } }

const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)
const n = (value: bigint | null | undefined) => Number(value ?? 0)

async function findCampaign(db: Tx, id: string) {
  const campaign = await db.campaign.findUnique({ where: { id } })
  if (!campaign) throw notFound('campaign:NOT_FOUND')
  return campaign
}

/** Flags the owner still has to look at: the reader's, unless dismissed, and never PASSED. */
export function openFlags(proof: { flags: string[]; dismissedAt: Date | null } | null): string[] {
  if (!proof || proof.dismissedAt) return []
  return proof.flags.filter((flag) => flag !== 'PASSED')
}

const orderInclude = {
  lines: { orderBy: { lineNo: 'asc' } },
  coupons: { include: { redemptions: { where: { status: 'COMPLETED' } } }, orderBy: { code: 'asc' } },
  proof: true,
} satisfies Prisma.CampaignOrderInclude

type OrderRow = Prisma.CampaignOrderGetPayload<{ include: typeof orderInclude }>

/** `columns`: the campaign's column settings, to find each line's message, style and design. */
export function orderView(order: OrderRow, columns: Record<string, string> = {}, sourceConfig: unknown = null) {
  return {
    id: order.id,
    externalRef: order.externalRef,
    customerName: order.customerName,
    contact: order.contact,
    submittedAt: order.submittedAt.toISOString(),
    expectedSen: order.expectedSen,
    paidSen: order.paidSen,
    paymentDate: iso(order.paymentDate),
    paymentRef: order.paymentRef,
    verification: order.verification,
    decidedByLabel: order.decidedByLabel,
    decidedAt: order.decidedAt?.toISOString() ?? null,
    reviewNote: order.reviewNote,
    posted: order.ledgerEntryId !== null && order.reversalEntryId === null,
    sourceStatus: order.sourceStatus,
    /** Marked paid in the sheet by hand, not yet verified here. */
    sheetSaysPaid: sheetSaysPaid(order.sourceStatus, order.verification, sourceConfig),
    fulfilment: order.fulfilment,
    deletedAt: order.deletedAt?.toISOString() ?? null,
    lines: order.lines.map((line) => {
      const art = lineArtwork(line.details, columns)
      return {
        id: line.id,
        lineNo: line.lineNo,
        label: line.label,
        priceSen: line.priceSen,
        campaignProductId: line.campaignProductId,
        message: art.message,
        messageStyle: art.messageStyle,
        hasDesign: art.designFileId !== null,
      }
    }),
    coupons: order.coupons.map((coupon) => ({
      code: coupon.code,
      lineId: coupon.orderLineId,
      redeemedAt: coupon.redemptions[0]?.redeemedAt.toISOString() ?? null,
      prepaidSen: coupon.redemptions[0]?.prepaidSen ?? null,
      voucherSen: coupon.redemptions[0]?.voucherSen ?? null,
    })),
    proof: order.proof
      ? {
          hasFile: order.proof.sourceRef !== null,
          readStatus: order.proof.readStatus,
          flags: order.proof.flags,
          openFlags: openFlags(order.proof),
          summary: order.proof.summary,
          extraction: order.proof.extraction,
          readAt: order.proof.readAt?.toISOString() ?? null,
          dismissedAt: order.proof.dismissedAt?.toISOString() ?? null,
        }
      : null,
  }
}

/** Which pickup columns hold the date and the time slot, by their names. */
export type PickupColumns = { date?: string; slot?: string }
export function pickupColumns(sourceConfig: unknown): PickupColumns {
  const names = ((sourceConfig ?? {}) as { fulfilmentColumns?: unknown }).fulfilmentColumns
  const list = Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
  return { date: list.find((name) => /date|day|tarikh/i.test(name)), slot: list.find((name) => /slot|time|masa/i.test(name)) }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A pickup date as forms write it ("Mon 23 Nov", "23/11/2026", "2026-11-23")
 * to YYYY-MM-DD. Without a year, the one that puts it nearest after the order.
 */
export function pickupIsoDate(text: string | undefined, submittedAt: Date): string | null {
  if (!text) return null
  const pad = (value: number) => String(value).padStart(2, '0')
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text)
  if (dmy) return `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`
  const named = /(\d{1,2})\s*([A-Za-z]{3})[a-z]*\.?(?:\s+(\d{4}))?/.exec(text)
  const month = named ? MONTHS.indexOf(named[2]!.toLowerCase()) : -1
  if (!named || month < 0) return null
  let year = named[3] ? Number(named[3]) : submittedAt.getUTCFullYear()
  // A December order collected in January.
  if (!named[3] && Date.UTC(year, month, Number(named[1])) < submittedAt.getTime() - 60 * 86_400_000) year += 1
  return `${year}-${pad(month + 1)}-${pad(Number(named[1]))}`
}

const fulfilmentText = (fulfilment: unknown, column: string | undefined) => {
  if (!column) return undefined
  const value = ((fulfilment ?? {}) as Record<string, unknown>)[column]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Over-the-counter sales of the campaign's walk-in menu items. Cancelled sales
 * are left out, and so are lines that came to nothing (a coupon's free item).
 */
async function walkInSales(db: Tx, businessId: string, campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { walkInProductIds: true } })
  const ids = campaign?.walkInProductIds ?? []
  if (ids.length === 0) return { sales: 0, units: 0, netSen: 0, items: [] as { productId: string; name: string; units: number; netSen: number }[] }
  const rows = await db.$queryRaw<{ product_id: string; name: string; sales: bigint; units: bigint; net: bigint }[]>`
    SELECT i.product_id, max(i.product_name) AS name, count(DISTINCT o.id) AS sales, sum(i.quantity) AS units,
           sum((i.unit_price_sen + i.modifier_total_sen) * i.quantity - i.line_discount_sen - i.allocated_order_discount_sen) AS net
    FROM order_items i
    JOIN orders o ON o.id = i.order_id AND o.business_id = i.business_id
    WHERE i.business_id = ${businessId} AND i.product_id IN (${Prisma.join(ids)})
      AND (i.unit_price_sen + i.modifier_total_sen) * i.quantity - i.line_discount_sen - i.allocated_order_discount_sen > 0
      AND NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.original_order_id = o.id AND c.business_id = o.business_id AND c.kind = 'CANCEL')
    GROUP BY i.product_id`
  const [total] = await db.$queryRaw<{ sales: bigint }[]>`
    SELECT count(DISTINCT o.id) AS sales
    FROM order_items i
    JOIN orders o ON o.id = i.order_id AND o.business_id = i.business_id
    WHERE i.business_id = ${businessId} AND i.product_id IN (${Prisma.join(ids)})
      AND (i.unit_price_sen + i.modifier_total_sen) * i.quantity - i.line_discount_sen - i.allocated_order_discount_sen > 0
      AND NOT EXISTS (SELECT 1 FROM sale_corrections c WHERE c.original_order_id = o.id AND c.business_id = o.business_id AND c.kind = 'CANCEL')`
  const items = rows
    .map((row) => ({ productId: row.product_id, name: row.name, units: n(row.units), netSen: n(row.net) }))
    .sort((a, b) => b.units - a.units || a.name.localeCompare(b.name))
  return {
    sales: n(total?.sales),
    units: items.reduce((sum, item) => sum + item.units, 0),
    netSen: items.reduce((sum, item) => sum + item.netSen, 0),
    items,
  }
}

async function campaignSummary(db: Tx, businessId: string, campaignId: string) {
  const [byStatus] = await db.$queryRaw<
    {
      orders: bigint
      expected: bigint | null
      verified_sen: bigint | null
      unverified: bigint
      verified: bigint
      rejected: bigint
    }[]
  >`
    SELECT count(*) AS orders,
           sum(expected_sen) FILTER (WHERE verification <> 'REJECTED') AS expected,
           sum(coalesce(paid_sen, expected_sen)) FILTER (WHERE verification = 'VERIFIED') AS verified_sen,
           count(*) FILTER (WHERE verification = 'UNVERIFIED') AS unverified,
           count(*) FILTER (WHERE verification = 'VERIFIED') AS verified,
           count(*) FILTER (WHERE verification = 'REJECTED') AS rejected
    FROM campaign_orders
    WHERE business_id = ${businessId} AND campaign_id = ${campaignId} AND deleted_at IS NULL`
  const [flags] = await db.$queryRaw<{ flagged: bigint; unread: bigint }[]>`
    SELECT count(*) FILTER (WHERE p.dismissed_at IS NULL AND EXISTS (SELECT 1 FROM unnest(p.flags) f WHERE f <> 'PASSED')) AS flagged,
           count(*) FILTER (WHERE p.read_status IN ('PENDING', 'READING')) AS unread
    FROM campaign_orders o JOIN campaign_payment_proofs p ON p.order_id = o.id AND p.business_id = o.business_id
    WHERE o.business_id = ${businessId} AND o.campaign_id = ${campaignId} AND o.deleted_at IS NULL AND o.verification = 'UNVERIFIED'`
  const [coupons] = await db.$queryRaw<{ issued: bigint; redeemed: bigint }[]>`
    SELECT count(*) AS issued,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM campaign_redemptions r WHERE r.coupon_id = c.id AND r.business_id = c.business_id AND r.status = 'COMPLETED')) AS redeemed
    FROM campaign_coupons c JOIN campaign_orders o ON o.id = c.order_id AND o.business_id = c.business_id
    WHERE c.business_id = ${businessId} AND c.campaign_id = ${campaignId} AND o.deleted_at IS NULL AND o.verification <> 'REJECTED'`
  // What is still owed to customers: the benefits of paid coupons not yet used.
  const [liability] = await db.$queryRaw<{ owed: bigint | null }[]>`
    SELECT sum(b.value_sen) AS owed
    FROM campaign_coupons c
    JOIN campaign_orders o ON o.id = c.order_id AND o.business_id = c.business_id
    LEFT JOIN campaign_order_lines l ON l.id = c.order_line_id AND l.business_id = c.business_id
    JOIN campaign_benefits b ON b.campaign_id = c.campaign_id AND b.business_id = c.business_id
         AND (b.campaign_product_id IS NULL OR b.campaign_product_id = l.campaign_product_id)
    WHERE c.business_id = ${businessId} AND c.campaign_id = ${campaignId} AND o.deleted_at IS NULL AND o.verification = 'VERIFIED'
      AND NOT EXISTS (SELECT 1 FROM campaign_redemptions r WHERE r.coupon_id = c.id AND r.business_id = c.business_id AND r.status = 'COMPLETED')`
  const lastRun = await db.campaignSyncRun.findFirst({ where: { campaignId }, orderBy: { startedAt: 'desc' } })
  const walkIns = await walkInSales(db, businessId, campaignId)
  return {
    orders: n(byStatus?.orders),
    expectedSen: n(byStatus?.expected),
    verifiedSen: n(byStatus?.verified_sen),
    unverified: n(byStatus?.unverified),
    verified: n(byStatus?.verified),
    rejected: n(byStatus?.rejected),
    flagged: n(flags?.flagged),
    unread: n(flags?.unread),
    couponsIssued: n(coupons?.issued),
    couponsRedeemed: n(coupons?.redeemed),
    outstandingSen: n(liability?.owed),
    walkIns,
    lastSync: lastRun
      ? {
          status: lastRun.status,
          trigger: lastRun.trigger,
          startedAt: lastRun.startedAt.toISOString(),
          finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          added: lastRun.added,
          updated: lastRun.updated,
          skipped: lastRun.skipped,
          error: lastRun.error,
        }
      : null,
  }
}

function listWhere(campaignId: string, query: z.infer<typeof listQuery>, pickup: PickupColumns = {}): Prisma.CampaignOrderWhereInput {
  const where: Prisma.CampaignOrderWhereInput = { campaignId }
  const and: Prisma.CampaignOrderWhereInput[] = []
  if (query.pickupDate && pickup.date) and.push({ fulfilment: { path: [pickup.date], equals: query.pickupDate } })
  if (query.pickupSlot && pickup.slot) and.push({ fulfilment: { path: [pickup.slot], equals: query.pickupSlot } })
  const handedOver: Prisma.CampaignOrderWhereInput = {
    OR: [
      { sourceStatus: { equals: 'Collected', mode: 'insensitive' } },
      { coupons: { some: {}, every: { redemptions: { some: { status: 'COMPLETED' } } } } },
    ],
  }
  if (query.collected === 'yes') and.push(handedOver)
  if (query.collected === 'no') and.push({ NOT: handedOver })
  if (and.length) where.AND = and
  if (query.includeDeleted === 'no') where.deletedAt = null
  if (query.includeDeleted === 'only') where.deletedAt = { not: null }
  if (query.verification) where.verification = query.verification
  if (query.q) {
    where.OR = [
      { externalRef: { contains: query.q, mode: 'insensitive' } },
      { customerName: { contains: query.q, mode: 'insensitive' } },
      { contact: { contains: query.q, mode: 'insensitive' } },
      { paymentRef: { contains: query.q, mode: 'insensitive' } },
      { coupons: { some: { code: { contains: query.q, mode: 'insensitive' } } } },
    ]
  }
  if (query.flag === 'NEEDS_ATTENTION') {
    where.verification = 'UNVERIFIED'
    where.proof = { dismissedAt: null, flags: { hasSome: FLAGS.filter((flag) => flag !== 'PASSED') } }
  } else if (query.flag === 'UNREAD') {
    where.proof = { readStatus: { in: ['PENDING', 'READING'] } }
  } else if (query.flag) {
    where.proof = { flags: { has: query.flag } }
  }
  if (query.redeemed === 'yes') where.coupons = { some: { redemptions: { some: { status: 'COMPLETED' } } } }
  if (query.redeemed === 'no') where.coupons = { some: { redemptions: { none: { status: 'COMPLETED' } } } }
  return where
}

export async function campaignOrderRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }

  app.post<Params>('/rms/campaigns/:id/sync', owner, async (request) => {
    const id = ID.parse(request.params.id)
    await findCampaign(request.db, id)
    return syncCampaign(request.db, request.businessId, id, 'MANUAL', campaignActor(request))
  })

  app.get<Params>('/rms/campaigns/:id/summary', owner, async (request) => {
    const id = ID.parse(request.params.id)
    await findCampaign(request.db, id)
    return campaignSummary(request.db, request.businessId, id)
  })

  app.get<Params>('/rms/campaigns/:id/orders', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const query = listQuery.parse(request.query)
    const config = (await findCampaign(request.db, id)).sourceConfig
    const pickup = pickupColumns(config)
    const where = listWhere(id, query, pickup)
    let total: number
    let rows: OrderRow[]
    if (query.sort === 'pickup') {
      // The pickup date is sheet text ("Mon 23 Nov"), so it is ordered here, not in SQL.
      const all = await request.db.campaignOrder.findMany({ where, include: orderInclude, take: 2000 })
      const key = (row: OrderRow) =>
        `${pickupIsoDate(fulfilmentText(row.fulfilment, pickup.date), row.submittedAt) ?? '9999'}|${fulfilmentText(row.fulfilment, pickup.slot) ?? ''}|${row.externalRef}`
      all.sort((a, b) => (query.dir === 'asc' ? 1 : -1) * key(a).localeCompare(key(b)))
      total = all.length
      rows = all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
    } else {
      const orderBy: Prisma.CampaignOrderOrderByWithRelationInput[] = [{ [query.sort]: query.dir }, { externalRef: 'asc' }]
      ;[total, rows] = await Promise.all([
        request.db.campaignOrder.count({ where }),
        request.db.campaignOrder.findMany({ where, include: orderInclude, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      ])
    }
    const columns = configColumns(config)
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      orders: rows.map((row) => ({
        ...orderView(row, columns, config),
        pickup: {
          date: fulfilmentText(row.fulfilment, pickup.date) ?? null,
          isoDate: pickupIsoDate(fulfilmentText(row.fulfilment, pickup.date), row.submittedAt),
          slot: fulfilmentText(row.fulfilment, pickup.slot) ?? null,
        },
      })),
    }
  })

  /** Every pickup date and slot on the campaign's live orders, in date order, for the filters. */
  app.get<Params>('/rms/campaigns/:id/pickups', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const pickup = pickupColumns((await findCampaign(request.db, id)).sourceConfig)
    const orders = await request.db.campaignOrder.findMany({
      where: { campaignId: id, deletedAt: null, verification: { not: 'REJECTED' } },
      select: { fulfilment: true, submittedAt: true },
    })
    const dates = new Map<string, { value: string; isoDate: string | null; orders: number; slots: Map<string, number> }>()
    for (const order of orders) {
      const value = fulfilmentText(order.fulfilment, pickup.date)
      if (!value) continue
      const entry = dates.get(value) ?? { value, isoDate: pickupIsoDate(value, order.submittedAt), orders: 0, slots: new Map<string, number>() }
      entry.orders += 1
      const slot = fulfilmentText(order.fulfilment, pickup.slot)
      if (slot) entry.slots.set(slot, (entry.slots.get(slot) ?? 0) + 1)
      dates.set(value, entry)
    }
    return {
      hasPickup: !!pickup.date,
      dates: [...dates.values()]
        .sort((a, b) => (a.isoDate ?? '9999').localeCompare(b.isoDate ?? '9999') || a.value.localeCompare(b.value))
        .map((entry) => ({
          value: entry.value,
          isoDate: entry.isoDate,
          orders: entry.orders,
          slots: [...entry.slots.entries()].map(([value, count]) => ({ value, orders: count })).sort((a, b) => a.value.localeCompare(b.value)),
        })),
    }
  })

  /** Ids of every order a filter matches, for "select all filtered". Capped. */
  app.get<Params>('/rms/campaigns/:id/orders/ids', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const query = listQuery.parse(request.query)
    const pickup = pickupColumns((await findCampaign(request.db, id)).sourceConfig)
    const rows = await request.db.campaignOrder.findMany({ where: listWhere(id, query, pickup), select: { id: true }, take: 2000 })
    return { ids: rows.map((row) => row.id) }
  })

  app.get<OrderParams>('/rms/campaigns/:id/orders/:orderId', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const campaign = await findCampaign(request.db, id)
    const order = await request.db.campaignOrder.findFirst({ where: { id: orderId, campaignId: id }, include: orderInclude })
    if (!order) throw notFound('campaign:ORDER_NOT_FOUND')
    const history = await request.db.campaignAuditEntry.findMany({ where: { orderId }, orderBy: { id: 'desc' }, take: 50 })
    const benefits = await request.db.campaignBenefit.findMany({ where: { campaignId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
    return {
      order: orderView(order, configColumns(campaign.sourceConfig), campaign.sourceConfig),
      /** What each coupon gives: benefits of its line's product, plus campaign-wide ones. */
      benefits: benefits.map((benefit) => ({
        id: benefit.id,
        campaignProductId: benefit.campaignProductId,
        kind: benefit.kind,
        label: benefit.label,
        valueSen: benefit.valueSen,
        expiresOn: iso(benefit.expiresOn),
      })),
      messageStyles: configStyles(campaign.sourceConfig),
      sourceData: order.sourceData,
      history: history.map((entry) => ({
        id: entry.id.toString(),
        actorLabel: entry.actorLabel,
        action: entry.action,
        after: entry.after,
        createdAt: entry.createdAt.toISOString(),
      })),
    }
  })

  /**
   * The payment proof, fetched from the source with the campaign's own read-only
   * access and handed to the owner only. Its fingerprint is kept for duplicate checks.
   */
  app.get<OrderParams>('/rms/campaigns/:id/orders/:orderId/proof', owner, async (request, reply) => {
    const id = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const campaign = await findCampaign(request.db, id)
    const order = await request.db.campaignOrder.findFirst({ where: { id: orderId, campaignId: id }, include: { proof: true } })
    if (!order) throw notFound('campaign:ORDER_NOT_FOUND')
    if (!order.proof?.sourceRef) throw notFound('campaign:PROOF_NOT_FOUND')
    let file: { bytes: Buffer; mimeType: string }
    try {
      file = await readDriveFile(sourceCredentials(campaign), order.proof.sourceRef)
    } catch {
      throw badRequest('campaign:PROOF_UNAVAILABLE')
    }
    if (!order.proof.sha256 || !order.proof.mimeType) {
      await request.db.campaignPaymentProof.update({
        where: { id: order.proof.id },
        data: { sha256: createHash('sha256').update(file.bytes).digest('hex'), mimeType: file.mimeType },
      })
    }
    reply.header('Content-Type', file.mimeType).header('Cache-Control', 'private, no-store')
    return reply.send(file.bytes)
  })

  /** A line's design preview (what the customer saw on the order form), fetched from the source like the proof. */
  app.get<{ Params: { id: string; orderId: string; lineId: string } }>('/rms/campaigns/:id/orders/:orderId/lines/:lineId/design', owner, async (request, reply) => {
    const id = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    const lineId = ID.parse(request.params.lineId)
    const campaign = await findCampaign(request.db, id)
    const line = await request.db.campaignOrderLine.findFirst({ where: { id: lineId, orderId, order: { campaignId: id } } })
    if (!line) throw notFound('campaign:ORDER_NOT_FOUND')
    const fileId = lineArtwork(line.details, configColumns(campaign.sourceConfig)).designFileId
    if (!fileId) throw notFound('campaign:DESIGN_NOT_FOUND')
    let file: { bytes: Buffer; mimeType: string }
    try {
      file = await readDriveFile(sourceCredentials(campaign), fileId)
    } catch {
      throw badRequest('campaign:DESIGN_UNAVAILABLE')
    }
    // Only ever hand back a picture: the link came from a sheet anyone with edit access can change.
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimeType)) throw badRequest('campaign:DESIGN_UNAVAILABLE')
    reply.header('Content-Type', file.mimeType).header('Cache-Control', 'private, no-store')
    return reply.send(file.bytes)
  })

  app.get<Params>('/rms/campaigns/:id/sync-runs', owner, async (request) => {
    const id = ID.parse(request.params.id)
    await findCampaign(request.db, id)
    const runs = await request.db.campaignSyncRun.findMany({ where: { campaignId: id }, orderBy: { startedAt: 'desc' }, take: 20 })
    return {
      runs: runs.map((run) => ({
        id: run.id,
        trigger: run.trigger,
        status: run.status,
        added: run.added,
        updated: run.updated,
        unchanged: run.unchanged,
        skipped: run.skipped,
        error: run.error,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      })),
    }
  })

  /**
   * Hermes calls this on a timer. It syncs every running sheet campaign of the
   * business whose last sync is older than its interval (10 minutes unless set).
   */
  app.post('/agent/campaigns/sync', { preHandler: requireAgent('BOOKKEEPER') }, async (request) => {
    const campaigns = await request.db.campaign.findMany({ where: { status: 'ACTIVE', sourceKind: 'GOOGLE_SHEET' } })
    const results: Array<{ campaignId: string; name: string; outcome: string }> = []
    for (const campaign of campaigns) {
      const every = Number((campaign.sourceConfig as Record<string, unknown>)?.syncEveryMinutes) || 10
      if (campaign.lastSyncedAt && Date.now() - campaign.lastSyncedAt.getTime() < every * 60_000) {
        results.push({ campaignId: campaign.id, name: campaign.name, outcome: 'not due' })
        continue
      }
      try {
        const summary = await syncCampaign(request.db, request.businessId, campaign.id, 'SCHEDULED', campaignActor(request))
        results.push({ campaignId: campaign.id, name: campaign.name, outcome: `+${summary.added} ~${summary.updated} =${summary.unchanged} !${summary.skipped}` })
      } catch (caught) {
        results.push({ campaignId: campaign.id, name: campaign.name, outcome: caught instanceof Error ? caught.message : 'failed' })
      }
    }
    // So Hermes asks for proofs only when there are some (each ask is a billed request). Same test as the claim.
    const proofsWaiting = await request.db.campaignPaymentProof.count({
      where: {
        sourceRef: { not: null },
        attempts: { lt: 5 },
        OR: [{ readStatus: 'PENDING' }, { readStatus: 'READING', leaseUntil: { lt: new Date() } }],
        order: { deletedAt: null, campaign: { status: { not: 'ARCHIVED' } } },
      },
    })
    return { results, proofsWaiting }
  })
}
