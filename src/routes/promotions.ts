import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc } from '../domain/business-date.ts'
import { badRequest, notFound } from '../errors.ts'

/**
 * Promotions, owner only, every query scoped to the business.
 *
 * A promo runs over a range of business dates and takes a percentage or an
 * amount off one of three things:
 *  - ORDER: the whole order. The cashier picks it from the discount screen, or
 *    — `autoApply` — it goes on every order by itself.
 *  - ITEMS: every item matching one of its targets (a product or a category).
 *  - COMBO: a set bought together — each target in its quantity.
 * Item and combo promos always apply by themselves. `limit` says whether one
 * applies to every match (EACH) or once per receipt.
 *
 * The counter works the amounts out (pos-vista/src/domain/promotions.ts) and
 * records them as ordinary discounts, which the server checks like any other.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const targetBody = z
  .object({
    productId: ID.nullish(),
    categoryId: ID.nullish(),
    quantity: z.number().int().min(1).max(20).default(1),
  })
  .refine((target) => Boolean(target.productId) !== Boolean(target.categoryId), {
    message: 'A target is one item or one category.',
  })

const promotionBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['PERCENT', 'AMOUNT']),
    /** A percentage (1–100), or sen off. */
    value: z.number().int().positive().max(10_000_000),
    scope: z.enum(['ORDER', 'ITEMS', 'COMBO']).default('ORDER'),
    autoApply: z.boolean().default(false),
    limit: z.enum(['EACH', 'ONCE_PER_ORDER']).default('EACH'),
    targets: z.array(targetBody).max(50).default([]),
    startsOn: DATE,
    endsOn: DATE.nullable(),
    isActive: z.boolean().default(true),
  })
  .superRefine((body, context) => {
    if (body.kind === 'PERCENT' && body.value > 100) {
      context.addIssue({ code: 'custom', path: ['value'], message: 'A percentage is at most 100.' })
    }
    if (body.endsOn !== null && body.endsOn < body.startsOn) {
      context.addIssue({ code: 'custom', path: ['endsOn'], message: 'It must end on or after it starts.' })
    }
    if (body.scope === 'ORDER' && body.targets.length > 0) {
      context.addIssue({ code: 'custom', path: ['targets'], message: 'A whole-order promo has no targets.' })
    }
    if (body.scope !== 'ORDER' && body.targets.length === 0) {
      context.addIssue({ code: 'custom', path: ['targets'], message: 'Choose what it applies to.' })
    }
  })

type Params = { Params: { id: string } }
type PromotionBody = z.infer<typeof promotionBody>

function toDate(value: string): Date {
  try {
    return businessDateToUtc(value)
  } catch {
    throw badRequest('validation:INVALID_REQUEST', `not a real date: ${value}`)
  }
}

type WithTargets = Prisma.PromotionGetPayload<{ include: { targets: true } }>

/** The wire shape, shared by the owner's snapshot and (in snake_case) the counter's bootstrap. */
export function serialisePromotion(promotion: WithTargets) {
  return {
    id: promotion.id,
    name: promotion.name,
    kind: promotion.kind,
    value: promotion.value,
    scope: promotion.scope,
    autoApply: promotion.autoApply,
    limit: promotion.limit,
    targets: promotion.targets
      .toSorted((a, b) => a.sortOrder - b.sortOrder)
      .map((target) => ({
        productId: target.productId,
        categoryId: target.categoryId,
        quantity: target.quantity,
      })),
    startsOn: promotion.startsOn.toISOString().slice(0, 10),
    endsOn: promotion.endsOn?.toISOString().slice(0, 10) ?? null,
    isActive: promotion.isActive,
  }
}

function fieldsFrom(body: PromotionBody) {
  return {
    name: body.name,
    kind: body.kind,
    value: body.value,
    scope: body.scope,
    // Item and combo promos only make sense applied by themselves.
    autoApply: body.scope === 'ORDER' ? body.autoApply : true,
    limit: body.limit,
    startsOn: toDate(body.startsOn),
    endsOn: body.endsOn === null ? null : toDate(body.endsOn),
    isActive: body.isActive,
  }
}

/** Every target must be one of this business's items or categories. */
async function assertTargetsExist(tx: Tx, targets: PromotionBody['targets']): Promise<void> {
  const productIds = [...new Set(targets.flatMap((target) => (target.productId ? [target.productId] : [])))]
  const categoryIds = [...new Set(targets.flatMap((target) => (target.categoryId ? [target.categoryId] : [])))]
  const [products, categories] = await Promise.all([
    productIds.length ? tx.product.count({ where: { id: { in: productIds } } }) : 0,
    categoryIds.length ? tx.category.count({ where: { id: { in: categoryIds } } }) : 0,
  ])
  if (products !== productIds.length || categories !== categoryIds.length) {
    throw badRequest('promo:UNKNOWN_TARGET')
  }
}

async function writeTargets(tx: Tx, businessId: string, promotionId: string, targets: PromotionBody['targets']) {
  await tx.promotionTarget.deleteMany({ where: { promotionId } })
  if (targets.length === 0) return
  await tx.promotionTarget.createMany({
    data: targets.map((target, index) => ({
      businessId,
      promotionId,
      productId: target.productId ?? null,
      categoryId: target.categoryId ?? null,
      quantity: target.quantity,
      sortOrder: index + 1,
    })),
  })
}

export async function promotionRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }

  app.post('/rms/promotions', owner, async (request) => {
    const body = promotionBody.parse(request.body)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      await assertTargetsExist(tx, body.targets)
      const last = await tx.promotion.findFirst({ orderBy: { sortOrder: 'desc' } })
      const created = await tx.promotion.create({
        data: { businessId, ...fieldsFrom(body), sortOrder: (last?.sortOrder ?? 0) + 1 },
      })
      await writeTargets(tx, businessId, created.id, body.targets)
      const saved = await tx.promotion.findUniqueOrThrow({ where: { id: created.id }, include: { targets: true } })
      return serialisePromotion(saved)
    })
  })

  /** Edit a promo. Past sales keep the discount they were given; nothing is recomputed. */
  app.put<Params>('/rms/promotions/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = promotionBody.parse(request.body)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      if (!(await tx.promotion.findUnique({ where: { id } }))) throw notFound('promo:NOT_FOUND')
      await assertTargetsExist(tx, body.targets)
      await tx.promotion.update({ where: { id }, data: fieldsFrom(body) })
      await writeTargets(tx, businessId, id, body.targets)
      const saved = await tx.promotion.findUniqueOrThrow({ where: { id }, include: { targets: true } })
      return serialisePromotion(saved)
    })
  })

  app.delete<Params>('/rms/promotions/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    try {
      // Its targets go with it (cascade).
      await db.promotion.delete({ where: { id } })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('promo:NOT_FOUND')
      }
      throw error
    }
    return { id }
  })
}
