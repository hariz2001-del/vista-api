import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import { businessDateToUtc } from '../domain/business-date.ts'
import { badRequest, notFound } from '../errors.ts'

/**
 * Promotions: discount presets the owner sets up, each running over a range of
 * business dates. The counter offers the ones running on its shift's date; the
 * cashier picks one and it fills in the discount. Owner only; every query is
 * scoped to the business through `request.db`.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const promotionBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['PERCENT', 'AMOUNT']),
    /** A percentage (1–100), or sen off. */
    value: z.number().int().positive().max(10_000_000),
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
  })

type Params = { Params: { id: string } }

function toDate(value: string): Date {
  try {
    return businessDateToUtc(value)
  } catch {
    throw badRequest('validation:INVALID_REQUEST', `not a real date: ${value}`)
  }
}

/** The wire shape, shared by the owner's snapshot and the counter's bootstrap. */
export function serialisePromotion(promotion: {
  id: string
  name: string
  kind: 'PERCENT' | 'AMOUNT'
  value: number
  startsOn: Date
  endsOn: Date | null
  isActive: boolean
}) {
  return {
    id: promotion.id,
    name: promotion.name,
    kind: promotion.kind,
    value: promotion.value,
    startsOn: promotion.startsOn.toISOString().slice(0, 10),
    endsOn: promotion.endsOn?.toISOString().slice(0, 10) ?? null,
    isActive: promotion.isActive,
  }
}

function dataFrom(body: z.infer<typeof promotionBody>) {
  return {
    name: body.name,
    kind: body.kind,
    value: body.value,
    startsOn: toDate(body.startsOn),
    endsOn: body.endsOn === null ? null : toDate(body.endsOn),
    isActive: body.isActive,
  }
}

export async function promotionRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }

  app.post('/rms/promotions', owner, async (request) => {
    const body = promotionBody.parse(request.body)
    const { db, businessId } = request
    const last = await db.promotion.findFirst({ orderBy: { sortOrder: 'desc' } })
    const promotion = await db.promotion.create({
      data: { businessId, ...dataFrom(body), sortOrder: (last?.sortOrder ?? 0) + 1 },
    })
    return serialisePromotion(promotion)
  })

  /** Edit a promo. Past sales keep the discount they were given; nothing is recomputed. */
  app.put<Params>('/rms/promotions/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = promotionBody.parse(request.body)
    const { db } = request
    if (!(await db.promotion.findUnique({ where: { id } }))) throw notFound('promo:NOT_FOUND')
    const promotion = await db.promotion.update({ where: { id }, data: dataFrom(body) })
    return serialisePromotion(promotion)
  })

  app.delete<Params>('/rms/promotions/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    try {
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
