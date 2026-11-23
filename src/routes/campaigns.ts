import { Prisma, type CampaignImageKind } from '@prisma/client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import { campaignActor, campaignAudit } from '../campaigns/audit.ts'
import { sealSecret } from '../campaigns/secrets.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc } from '../domain/business-date.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

/**
 * Campaigns, owner only: the campaign itself, what customers can pre-order,
 * what a coupon gives at the till, the tile images, and where orders come from.
 *
 * Nothing in here knows about any one campaign. Sarang in Bloom is rows.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const SEN = z.number().int().min(0).max(100_000_000)
const IMAGE_KINDS = ['BACKGROUND', 'LOGO'] as const

const campaignBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullish(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  brandId: ID.nullish(),
  tileTone: z.enum(['LIGHT', 'DARK']).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  startsOn: DATE.nullish(),
  endsOn: DATE.nullish(),
  /** Menu items sold as walk-ins for this campaign, counted on its dashboard. */
  walkInProductIds: z.array(ID).max(20).optional(),
})

const productBody = z.object({
  id: ID.optional(),
  name: z.string().trim().min(1).max(80),
  externalKey: z.string().trim().min(1).max(120).nullish(),
  priceSen: SEN,
  isActive: z.boolean().default(true),
})

const benefitBody = z
  .object({
    /** Index into `products` of what it belongs to; null applies to every coupon. */
    productIndex: z.number().int().min(0).nullish(),
    kind: z.enum(['PREPAID_PRODUCT', 'FIXED_VOUCHER']),
    label: z.string().trim().min(1).max(80),
    valueSen: SEN,
    productId: ID.nullish(),
    /** A voucher limited to items of these categories. Empty: any item. */
    categoryIds: z.array(ID).max(30).default([]),
    expiresOn: DATE.nullish(),
  })
  .superRefine((benefit, context) => {
    if (benefit.kind === 'FIXED_VOUCHER' && benefit.valueSen === 0) {
      context.addIssue({ code: 'custom', path: ['valueSen'], message: 'A voucher takes something off.' })
    }
    if (benefit.kind === 'FIXED_VOUCHER' && benefit.productId && benefit.categoryIds.length) {
      context.addIssue({ code: 'custom', path: ['categoryIds'], message: 'Limit a voucher to one item or to categories, not both.' })
    }
    if (benefit.kind === 'PREPAID_PRODUCT' && benefit.categoryIds.length) {
      context.addIssue({ code: 'custom', path: ['categoryIds'], message: 'A prepaid item is one item, not a category.' })
    }
  })

const catalogueBody = z.object({
  products: z.array(productBody).max(50),
  benefits: z.array(benefitBody).max(50),
})

const imageBody = z.object({
  imageBase64: z.string().min(1).max(4_200_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
})

/** Where orders come from. Config holds no secrets; `secret` is sealed. */
const sourceBody = z.object({
  kind: z.enum(['NONE', 'GOOGLE_SHEET']),
  config: z
    .object({
      sheetId: z.string().trim().min(10).max(200).optional(),
      tab: z.string().trim().min(1).max(100).optional(),
      /** Source column name for each field Vista reads. */
      columns: z.record(z.string(), z.string().trim().max(100)).optional(),
      /** Whether the total column is the whole order's or each line's. */
      totalPer: z.enum(['ORDER', 'LINE']).optional(),
      /** Columns shown as pickup / fulfilment details. */
      fulfilmentColumns: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
      /** VISTA: use Vista's own Google connection (share the sheet with it). Else the sealed keys. */
      auth: z.enum(['VISTA', 'OWN']).optional(),
      /** Write Vista's decisions back to the sheet (status, voucher used). Off unless set. */
      writeBack: z
        .object({
          enabled: z.boolean(),
          verified: z.string().trim().min(1).max(60).default('Paid'),
          rejected: z.string().trim().min(1).max(60).default('Rejected'),
          unverified: z.string().trim().min(1).max(60).default('Pending check'),
          /** Sheet statuses that already mean "paid" and are left alone on verify (e.g. Ready, Collected). */
          keepWhenVerified: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
        })
        .optional(),
      /** How often Hermes syncs, in minutes. */
      syncEveryMinutes: z.number().int().min(5).max(1440).optional(),
      /** How each lettering style the customer can pick is shown: style name → Google Fonts family (+ weight). */
      messageStyles: z
        .record(
          z.string().trim().min(1).max(60),
          z.object({
            font: z.string().trim().regex(/^[A-Za-z0-9 ]{1,60}$/, 'a Google Fonts family name'),
            weight: z.number().int().min(100).max(900).multipleOf(100).optional(),
          }),
        )
        .refine((styles) => Object.keys(styles).length <= 12, 'at most 12 styles')
        .optional(),
    })
    .default({}),
  /** New credentials, or undefined to keep the stored ones, or null to clear them. */
  secret: z.record(z.string(), z.string().min(1).max(4000)).nullish(),
})

type Params = { Params: { id: string } }
type ImageParams = { Params: { id: string; kind: string } }

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  try {
    return businessDateToUtc(value)
  } catch {
    throw badRequest('validation:INVALID_REQUEST', `not a real date: ${value}`)
  }
}

const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)

async function findCampaign(db: Tx, id: string) {
  const campaign = await db.campaign.findUnique({ where: { id } })
  if (!campaign) throw notFound('campaign:NOT_FOUND')
  return campaign
}

function assertEditable(campaign: { status: string }) {
  if (campaign.status === 'ARCHIVED') throw conflict('campaign:ARCHIVED')
}

type CampaignRow = Prisma.CampaignGetPayload<object>

/** The tile: what the Campaigns page shows. */
function campaignView(
  campaign: CampaignRow,
  images: { kind: CampaignImageKind; createdAt: Date; width: number; height: number }[],
  counts?: Record<string, number>,
) {
  const image = (kind: CampaignImageKind) => {
    const found = images.find((row) => row.kind === kind)
    return found ? { version: found.createdAt.getTime(), width: found.width, height: found.height } : null
  }
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    brandId: campaign.brandId,
    tileTone: campaign.tileTone,
    sortOrder: campaign.sortOrder,
    walkInProductIds: campaign.walkInProductIds,
    startsOn: iso(campaign.startsOn),
    endsOn: iso(campaign.endsOn),
    background: image('BACKGROUND'),
    logo: image('LOGO'),
    sourceKind: campaign.sourceKind,
    lastSyncedAt: campaign.lastSyncedAt?.toISOString() ?? null,
    archivedAt: campaign.archivedAt?.toISOString() ?? null,
    counts: counts ?? null,
  }
}

async function orderCounts(db: Tx, businessId: string, campaignIds: string[]) {
  if (campaignIds.length === 0) return new Map<string, Record<string, number>>()
  const rows = await db.$queryRaw<{ campaign_id: string; verification: string; n: bigint }[]>`
    SELECT campaign_id, verification::text AS verification, count(*) AS n
    FROM campaign_orders
    WHERE business_id = ${businessId} AND deleted_at IS NULL AND campaign_id IN (${Prisma.join(campaignIds)})
    GROUP BY campaign_id, verification`
  const map = new Map<string, Record<string, number>>()
  for (const row of rows) {
    const entry = map.get(row.campaign_id) ?? { orders: 0, UNVERIFIED: 0, VERIFIED: 0, REJECTED: 0 }
    entry[row.verification] = Number(row.n)
    entry.orders = (entry.orders ?? 0) + Number(row.n)
    map.set(row.campaign_id, entry)
  }
  return map
}

/** Everything the campaign's settings screen needs. Never the sealed secret. */
async function campaignDetail(db: Tx, id: string) {
  const campaign = await findCampaign(db, id)
  const [images, products, benefits] = await Promise.all([
    db.campaignImage.findMany({ where: { campaignId: id }, select: { kind: true, createdAt: true, width: true, height: true } }),
    db.campaignProduct.findMany({ where: { campaignId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    db.campaignBenefit.findMany({ where: { campaignId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
  ])
  return {
    campaign: campaignView(campaign, images),
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      externalKey: product.externalKey,
      priceSen: product.priceSen,
      isActive: product.isActive,
    })),
    benefits: benefits.map((benefit) => ({
      id: benefit.id,
      campaignProductId: benefit.campaignProductId,
      kind: benefit.kind,
      label: benefit.label,
      valueSen: benefit.valueSen,
      productId: benefit.productId,
      categoryIds: benefit.categoryIds,
      expiresOn: iso(benefit.expiresOn),
    })),
    source: {
      kind: campaign.sourceKind,
      config: campaign.sourceConfig,
      hasSecret: campaign.sourceSecret !== null,
    },
  }
}

/** Resized once on upload so tiles load fast: backgrounds 1600px wide, logos 400px. */
async function prepareImage(kind: CampaignImageKind, base64: string) {
  const input = Buffer.from(base64, 'base64')
  if (input.length === 0 || input.length > 3_100_000) throw badRequest('campaign:IMAGE_INVALID')
  try {
    const max = kind === 'BACKGROUND' ? 1600 : 400
    const { data, info } = await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: kind === 'BACKGROUND' ? 80 : 90 })
      .toBuffer({ resolveWithObject: true })
    return { bytes: data, width: info.width, height: info.height, mimeType: 'image/webp' }
  } catch {
    throw badRequest('campaign:IMAGE_INVALID')
  }
}

function imageKind(raw: string): CampaignImageKind {
  const kind = raw.toUpperCase()
  if (!(IMAGE_KINDS as readonly string[]).includes(kind)) throw notFound('campaign:NOT_FOUND')
  return kind as CampaignImageKind
}

/** Brand, product and category ids from a body must belong to this business. */
async function assertOwnedRefs(db: Tx, refs: { brandId?: string | null; productIds?: string[]; categoryIds?: string[] }) {
  if (refs.brandId) {
    if (!(await db.brand.findUnique({ where: { id: refs.brandId } }))) throw badRequest('validation:INVALID_REQUEST', 'unknown brand')
  }
  const productIds = [...new Set(refs.productIds ?? [])]
  if (productIds.length && (await db.product.count({ where: { id: { in: productIds } } })) !== productIds.length) {
    throw badRequest('campaign:BENEFIT_INVALID', 'unknown product')
  }
  const categoryIds = [...new Set(refs.categoryIds ?? [])]
  if (categoryIds.length && (await db.category.count({ where: { id: { in: categoryIds } } })) !== categoryIds.length) {
    throw badRequest('campaign:BENEFIT_INVALID', 'unknown category')
  }
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }
  const actor = (request: FastifyRequest) => campaignActor(request)

  app.get('/rms/campaigns', owner, async (request) => {
    const db = request.db
    const campaigns = await db.campaign.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
    const ids = campaigns.map((campaign) => campaign.id)
    const [images, counts] = await Promise.all([
      db.campaignImage.findMany({
        where: { campaignId: { in: ids } },
        select: { campaignId: true, kind: true, createdAt: true, width: true, height: true },
      }),
      orderCounts(db, request.businessId, ids),
    ])
    return {
      campaigns: campaigns.map((campaign) =>
        campaignView(
          campaign,
          images.filter((image) => image.campaignId === campaign.id),
          counts.get(campaign.id) ?? { orders: 0, UNVERIFIED: 0, VERIFIED: 0, REJECTED: 0 },
        ),
      ),
    }
  })

  app.post('/rms/campaigns', owner, async (request, reply) => {
    const body = campaignBody.parse(request.body)
    const db = request.db
    await assertOwnedRefs(db, { brandId: body.brandId })
    const created = await db.$transaction(async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          businessId: request.businessId,
          name: body.name,
          description: body.description ?? null,
          status: body.status ?? 'DRAFT',
          brandId: body.brandId ?? null,
          tileTone: body.tileTone ?? 'LIGHT',
          sortOrder: body.sortOrder ?? 0,
          startsOn: toDate(body.startsOn),
          endsOn: toDate(body.endsOn),
        },
      })
      await campaignAudit(tx, request.businessId, actor(request), { campaignId: campaign.id, action: 'campaign.create', after: body })
      return campaign
    })
    reply.code(201)
    return campaignDetail(db, created.id)
  })

  app.get<Params>('/rms/campaigns/:id', owner, async (request) => campaignDetail(request.db, ID.parse(request.params.id)))

  app.patch<Params>('/rms/campaigns/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = campaignBody.partial().parse(request.body)
    const db = request.db
    await assertOwnedRefs(db, { brandId: body.brandId, productIds: body.walkInProductIds })
    await db.$transaction(async (tx) => {
      const before = await findCampaign(tx, id)
      // An archived campaign only changes by being restored.
      if (before.status === 'ARCHIVED' && (body.status === undefined || body.status === 'ARCHIVED')) assertEditable(before)
      const data: Prisma.CampaignUpdateInput = {}
      if (body.name !== undefined) data.name = body.name
      if (body.description !== undefined) data.description = body.description ?? null
      if (body.brandId !== undefined) data.brand = body.brandId ? { connect: { id: body.brandId } } : { disconnect: true }
      if (body.tileTone !== undefined) data.tileTone = body.tileTone
      if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
      if (body.startsOn !== undefined) data.startsOn = toDate(body.startsOn)
      if (body.endsOn !== undefined) data.endsOn = toDate(body.endsOn)
      if (body.walkInProductIds !== undefined) data.walkInProductIds = [...new Set(body.walkInProductIds)]
      if (body.status !== undefined) {
        data.status = body.status
        data.archivedAt = body.status === 'ARCHIVED' ? new Date() : null
      }
      await tx.campaign.update({ where: { id }, data })
      await campaignAudit(tx, request.businessId, actor(request), {
        campaignId: id,
        action: body.status && body.status !== before.status ? `campaign.status.${body.status.toLowerCase()}` : 'campaign.edit',
        before: { name: before.name, status: before.status, brandId: before.brandId, tileTone: before.tileTone, walkInProductIds: before.walkInProductIds },
        after: body,
      })
    })
    return campaignDetail(db, id)
  })

  /**
   * Replace what can be pre-ordered and what a coupon gives. Products already on
   * imported orders are switched off rather than deleted, so history keeps them.
   */
  app.put<Params>('/rms/campaigns/:id/catalogue', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = catalogueBody.parse(request.body)
    const db = request.db
    for (const benefit of body.benefits) {
      if (benefit.productIndex != null && benefit.productIndex >= body.products.length) {
        throw badRequest('campaign:BENEFIT_INVALID', 'productIndex out of range')
      }
    }
    await assertOwnedRefs(db, {
      productIds: body.benefits.flatMap((benefit) => (benefit.productId ? [benefit.productId] : [])),
      categoryIds: body.benefits.flatMap((benefit) => benefit.categoryIds),
    })
    const keys = body.products.map((product) => product.externalKey).filter(Boolean)
    if (new Set(keys).size !== keys.length) throw badRequest('validation:INVALID_REQUEST', 'two products share a source name')

    await db.$transaction(async (tx) => {
      const campaign = await findCampaign(tx, id)
      assertEditable(campaign)
      const existing = await tx.campaignProduct.findMany({ where: { campaignId: id } })
      const before = await tx.campaignBenefit.findMany({ where: { campaignId: id } })

      // Free source names first, so two products can swap them in one save.
      const keptIds = new Set(body.products.flatMap((product) => (product.id ? [product.id] : [])))
      for (const product of existing) {
        if (!keptIds.has(product.id) && product.externalKey !== null) {
          await tx.campaignProduct.update({ where: { id: product.id }, data: { externalKey: null } })
        }
      }

      const ids: string[] = []
      for (const [index, product] of body.products.entries()) {
        const data = {
          name: product.name,
          externalKey: product.externalKey ?? null,
          priceSen: product.priceSen,
          isActive: product.isActive,
          sortOrder: index,
        }
        if (product.id) {
          if (!existing.some((row) => row.id === product.id)) throw badRequest('validation:INVALID_REQUEST', 'unknown product')
          await tx.campaignProduct.update({ where: { id: product.id }, data })
          ids.push(product.id)
        } else {
          const created = await tx.campaignProduct.create({ data: { ...data, businessId: request.businessId, campaignId: id } })
          ids.push(created.id)
        }
      }
      for (const product of existing.filter((row) => !keptIds.has(row.id))) {
        const used = await tx.campaignOrderLine.count({ where: { campaignProductId: product.id } })
        if (used > 0) await tx.campaignProduct.update({ where: { id: product.id }, data: { isActive: false } })
        else await tx.campaignProduct.delete({ where: { id: product.id } })
      }

      // Benefits are replaced whole. A redemption keeps its own copy of what it gave.
      await tx.campaignBenefit.deleteMany({ where: { campaignId: id } })
      for (const [index, benefit] of body.benefits.entries()) {
        await tx.campaignBenefit.create({
          data: {
            businessId: request.businessId,
            campaignId: id,
            campaignProductId: benefit.productIndex != null ? ids[benefit.productIndex]! : null,
            kind: benefit.kind,
            label: benefit.label,
            valueSen: benefit.valueSen,
            productId: benefit.productId ?? null,
            categoryIds: [...new Set(benefit.categoryIds)],
            expiresOn: toDate(benefit.expiresOn),
            sortOrder: index,
          },
        })
      }
      await campaignAudit(tx, request.businessId, actor(request), {
        campaignId: id,
        action: 'campaign.catalogue',
        before: { products: existing, benefits: before },
        after: body,
      })
    })
    return campaignDetail(db, id)
  })

  app.get<ImageParams>('/rms/campaigns/:id/images/:kind', owner, async (request, reply) => {
    const id = ID.parse(request.params.id)
    const kind = imageKind(request.params.kind)
    const image = await request.db.campaignImage.findFirst({ where: { campaignId: id, kind } })
    if (!image) throw notFound('campaign:NOT_FOUND')
    reply.header('Content-Type', image.mimeType).header('Cache-Control', 'private, max-age=86400')
    return reply.send(Buffer.from(image.bytes))
  })

  app.put<ImageParams>('/rms/campaigns/:id/images/:kind', { ...owner, bodyLimit: 4_400_000 }, async (request) => {
    const id = ID.parse(request.params.id)
    const kind = imageKind(request.params.kind)
    const body = imageBody.parse(request.body)
    const image = await prepareImage(kind, body.imageBase64)
    const db = request.db
    await db.$transaction(async (tx) => {
      assertEditable(await findCampaign(tx, id))
      await tx.campaignImage.deleteMany({ where: { campaignId: id, kind } })
      await tx.campaignImage.create({
        data: { businessId: request.businessId, campaignId: id, kind, ...image, bytes: new Uint8Array(image.bytes) },
      })
      await campaignAudit(tx, request.businessId, actor(request), {
        campaignId: id,
        action: `campaign.image.${kind.toLowerCase()}.set`,
        after: { width: image.width, height: image.height, bytes: image.bytes.length },
      })
    })
    return campaignDetail(db, id)
  })

  app.delete<ImageParams>('/rms/campaigns/:id/images/:kind', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const kind = imageKind(request.params.kind)
    const db = request.db
    await db.$transaction(async (tx) => {
      assertEditable(await findCampaign(tx, id))
      const removed = await tx.campaignImage.deleteMany({ where: { campaignId: id, kind } })
      if (removed.count > 0) {
        await campaignAudit(tx, request.businessId, actor(request), { campaignId: id, action: `campaign.image.${kind.toLowerCase()}.remove` })
      }
    })
    return campaignDetail(db, id)
  })

  app.put<Params>('/rms/campaigns/:id/source', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = sourceBody.parse(request.body)
    const db = request.db
    const sealed = body.secret ? sealSecret(body.secret) : body.secret
    await db.$transaction(async (tx) => {
      const before = await findCampaign(tx, id)
      assertEditable(before)
      const data: Prisma.CampaignUpdateInput = {
        sourceKind: body.kind,
        sourceConfig: body.config as Prisma.InputJsonValue,
      }
      if (sealed !== undefined) data.sourceSecret = sealed
      await tx.campaign.update({ where: { id }, data })
      await campaignAudit(tx, request.businessId, actor(request), {
        campaignId: id,
        action: 'campaign.source',
        before: { kind: before.sourceKind, config: before.sourceConfig, hasSecret: before.sourceSecret !== null },
        // Which credential fields changed, never their values.
        after: { kind: body.kind, config: body.config, secretFields: body.secret ? Object.keys(body.secret) : body.secret },
      })
    })
    return campaignDetail(db, id)
  })

  app.get<Params>('/rms/campaigns/:id/audit', owner, async (request) => {
    const id = ID.parse(request.params.id)
    await findCampaign(request.db, id)
    const rows = await request.db.campaignAuditEntry.findMany({
      where: { campaignId: id },
      orderBy: { id: 'desc' },
      take: 200,
    })
    return {
      entries: rows.map((row) => ({
        id: row.id.toString(),
        orderId: row.orderId,
        actorKind: row.actorKind,
        actorLabel: row.actorLabel,
        action: row.action,
        before: row.before,
        after: row.after,
        createdAt: row.createdAt.toISOString(),
      })),
    }
  })
}
