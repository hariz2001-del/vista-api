import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner, requireUser } from '../auth.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc, businessToday } from '../domain/business-date.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

/**
 * Closing stock: a quick estimate the counter fills in at the end of the day.
 *
 * The owner decides what is on the list (RMS); the counter fills it in (POS);
 * the owner reads past counts back (RMS). That is all. There is no stock on
 * hand, no movement, no reorder level — a count is a snapshot someone looked
 * at, kept so tomorrow's restock can be planned from it.
 *
 * A submitted count copies each item's set-up onto its lines, so renaming,
 * regrouping or removing an item later never changes how an old count reads.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const LABEL = z.string().trim().min(1).max(60)
/** Blank means absent, so an emptied field stores null rather than "". */
const OPTIONAL_LABEL = z
  .string()
  .trim()
  .max(60)
  .nullish()
  .transform((value) => (value ? value : null))
/** Thousandths of a unit. 100,000 of anything is not a closing count. */
const QUANTITY = z.number().int().min(0).max(100_000_000).nullable()
/** A new count uses the five-step level; the old three-step values are history only. */
const BALANCE = z.enum(['EMPTY', 'QUARTER', 'HALF', 'THREE_QUARTERS', 'FULL']).nullable()

const itemBody = z
  .object({
    brandId: ID,
    category: LABEL,
    subcategory: OPTIONAL_LABEL,
    name: z.string().trim().min(1).max(80),
    unitLabel: OPTIONAL_LABEL,
    trackUnopened: z.boolean(),
    trackOpened: z.boolean(),
    trackBalance: z.boolean(),
    isActive: z.boolean().default(true),
  })
  .refine((item) => item.trackUnopened || item.trackOpened || item.trackBalance, {
    message: 'Track at least one thing for an item.',
  })

const orderBody = z.object({ ids: z.array(ID).max(1000) })

const countBody = z.object({
  /** A rostered staff member picked on the counter. */
  staffId: ID.nullable().default(null),
  /** Typed on the counter when the person is not on the list. */
  staffName: z.string().trim().max(60).nullable().default(null),
  remarks: z.string().trim().max(1000).nullable().default(null),
  lines: z
    .array(
      z.object({
        stockItemId: ID,
        unopenedMilli: QUANTITY.default(null),
        openedMilli: QUANTITY.default(null),
        balance: BALANCE.default(null),
      }),
    )
    .max(1000),
})

const countsQuery = z.object({
  from: DATE.optional(),
  to: DATE.optional(),
  staff: z.string().trim().max(60).optional(),
  branch: z.string().trim().max(80).optional(),
})

type ItemRow = Awaited<ReturnType<Tx['stockItem']['findMany']>>[number]

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function serialiseItem(item: ItemRow) {
  return {
    id: item.id,
    brandId: item.brandId,
    category: item.category,
    subcategory: item.subcategory,
    name: item.name,
    unitLabel: item.unitLabel,
    trackUnopened: item.trackUnopened,
    trackOpened: item.trackOpened,
    trackBalance: item.trackBalance,
    isActive: item.isActive,
    sortOrder: item.sortOrder,
  }
}

/** The list in the owner's order: by brand, then as arranged within it. */
async function orderedItems(db: Tx, where: { isActive?: boolean } = {}) {
  const [brands, items] = await Promise.all([
    db.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
    db.stockItem.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
  ])
  const brandRank = new Map(brands.map((brand, index) => [brand.id, index]))
  return {
    brands,
    items: items.toSorted(
      (a, b) => (brandRank.get(a.brandId) ?? 0) - (brandRank.get(b.brandId) ?? 0),
    ),
  }
}

/**
 * Who might be counting: everyone active, those rostered around now first.
 * "Around now" is a shift that started within the last day and has not long
 * ended, which catches the evening shift doing the count at close.
 */
async function staffForCount(db: Tx) {
  const now = Date.now()
  const [staff, assignments] = await Promise.all([
    db.staffMember.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } }),
    db.assignment.findMany({
      where: {
        status: 'ACTIVE',
        slot: {
          startsAt: { lte: new Date(now + 2 * 60 * 60_000), gte: new Date(now - 24 * 60 * 60_000) },
          endsAt: { gte: new Date(now - 6 * 60 * 60_000) },
          rosterWeek: { status: 'PUBLISHED' },
        },
      },
      include: { slot: { select: { startsAt: true, endsAt: true } } },
    }),
  ])

  const onShift = new Map<string, { onNow: boolean; endsAt: number }>()
  for (const assignment of assignments) {
    const startsAt = assignment.slot.startsAt.getTime()
    const endsAt = assignment.slot.endsAt.getTime()
    const onNow = startsAt <= now && now <= endsAt
    const known = onShift.get(assignment.staffId)
    if (!known || onNow || endsAt > known.endsAt) {
      onShift.set(assignment.staffId, { onNow: onNow || (known?.onNow ?? false), endsAt })
    }
  }

  return staff
    .map((member) => ({
      id: member.id,
      name: member.name,
      rostered: onShift.has(member.id),
      onNow: onShift.get(member.id)?.onNow ?? false,
      endsAt: onShift.get(member.id)?.endsAt ?? 0,
    }))
    .toSorted(
      (a, b) =>
        Number(b.onNow) - Number(a.onNow) ||
        Number(b.rostered) - Number(a.rostered) ||
        b.endsAt - a.endsAt ||
        a.name.localeCompare(b.name),
    )
    .map(({ endsAt: _endsAt, ...member }) => member)
}

async function branchName(db: Tx, businessId: string): Promise<string> {
  const settings = await db.accountSettings.findUnique({ where: { businessId } })
  return settings?.outletName || settings?.businessName || 'Main'
}

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }
  const counter = { preHandler: requireUser }

  // -------------------------------------------------------------------------
  // The list (RMS)
  // -------------------------------------------------------------------------

  app.get('/rms/stock/items', owner, async (request) => {
    const { items } = await orderedItems(request.db)
    return { items: items.map(serialiseItem) }
  })

  app.post('/rms/stock/items', owner, async (request) => {
    const body = itemBody.parse(request.body)
    const { db, businessId } = request
    if (!(await db.brand.findUnique({ where: { id: body.brandId } }))) {
      throw notFound('menu:BRAND_NOT_FOUND')
    }
    // New items go to the end of the list; the owner moves them from there.
    const last = await db.stockItem.aggregate({ _max: { sortOrder: true } })
    const item = await db.stockItem.create({
      data: { ...body, businessId, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    })
    return { item: serialiseItem(item) }
  })

  app.put<{ Params: { id: string } }>('/rms/stock/items/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = itemBody.parse(request.body)
    const { db } = request
    if (!(await db.stockItem.findUnique({ where: { id } }))) throw notFound('stock:ITEM_NOT_FOUND')
    if (!(await db.brand.findUnique({ where: { id: body.brandId } }))) {
      throw notFound('menu:BRAND_NOT_FOUND')
    }
    const item = await db.stockItem.update({ where: { id }, data: body })
    return { item: serialiseItem(item) }
  })

  /** Past counts keep their own copy of the item, so deleting it loses nothing. */
  app.delete<{ Params: { id: string } }>('/rms/stock/items/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const removed = await request.db.stockItem.deleteMany({ where: { id } })
    if (removed.count === 0) throw notFound('stock:ITEM_NOT_FOUND')
    return { id }
  })

  /** The whole list in its new order. Anything missing or extra is refused. */
  app.put('/rms/stock/items/order', owner, async (request) => {
    const { ids } = orderBody.parse(request.body)
    const { db } = request
    return db.$transaction(async (tx) => {
      const existing = await tx.stockItem.findMany({ select: { id: true } })
      const known = new Set(existing.map((item) => item.id))
      if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
        throw conflict('stock:ORDER_MISMATCH')
      }
      for (const [index, id] of ids.entries()) {
        await tx.stockItem.update({ where: { id }, data: { sortOrder: index } })
      }
      return { ok: true }
    })
  })

  // -------------------------------------------------------------------------
  // The count (POS)
  // -------------------------------------------------------------------------

  /** Everything the counter needs to fill in tonight's count. */
  app.get('/stock/sheet', counter, async (request) => {
    const { db, businessId } = request
    const [{ brands, items }, staff, branch, openShift, today] = await Promise.all([
      orderedItems(db, { isActive: true }),
      staffForCount(db),
      branchName(db, businessId),
      db.shift.findFirst({ where: { status: 'OPEN' } }),
      businessToday(db, businessId),
    ])
    return {
      // A shift still open past midnight counts for the night it opened.
      businessDate: openShift ? isoDate(openShift.businessDate) : today,
      branchName: branch,
      brands: brands.map((brand) => ({ id: brand.id, name: brand.name, colour: brand.colour })),
      items: items.map(serialiseItem),
      staff,
    }
  })

  /**
   * Submit a count. Every active item gets a line, filled in or not, with its
   * set-up copied from the database — never from the tablet — so the report
   * reads exactly as the list stood when it was counted.
   */
  app.post('/stock/counts', counter, async (request) => {
    const body = countBody.parse(request.body)
    const { db, businessId } = request

    return db.$transaction(async (tx) => {
      const [{ brands, items }, branch, openShift, today] = await Promise.all([
        orderedItems(tx, { isActive: true }),
        branchName(tx, businessId),
        tx.shift.findFirst({ where: { status: 'OPEN' } }),
        businessToday(tx, businessId),
      ])

      let staffName = body.staffName
      if (body.staffId) {
        const member = await tx.staffMember.findUnique({ where: { id: body.staffId } })
        if (!member) throw badRequest('stock:UNKNOWN_STAFF')
        staffName = member.name
      }
      if (!staffName) throw badRequest('stock:WHO_COUNTED')

      const entered = new Map(body.lines.map((line) => [line.stockItemId, line]))
      const brandName = new Map(brands.map((brand) => [brand.id, brand.name]))

      const count = await tx.stockCount.create({
        data: {
          businessId,
          businessDate: openShift ? openShift.businessDate : businessDateToUtc(today),
          branchName: branch,
          staffId: body.staffId,
          staffName,
          submittedById: request.user.id,
          remarks: body.remarks || null,
          lines: {
            create: items.map((item, position) => {
              const line = entered.get(item.id)
              return {
                stockItemId: item.id,
                brandId: item.brandId,
                brandName: brandName.get(item.brandId) ?? '—',
                category: item.category,
                subcategory: item.subcategory,
                name: item.name,
                unitLabel: item.unitLabel,
                trackUnopened: item.trackUnopened,
                trackOpened: item.trackOpened,
                trackBalance: item.trackBalance,
                position,
                // A figure for something not tracked is dropped, not stored.
                unopenedMilli: item.trackUnopened ? (line?.unopenedMilli ?? null) : null,
                openedMilli: item.trackOpened ? (line?.openedMilli ?? null) : null,
                balance: item.trackBalance ? (line?.balance ?? null) : null,
              }
            }),
          },
        },
      })
      return { id: count.id }
    })
  })

  // -------------------------------------------------------------------------
  // Past counts (RMS)
  // -------------------------------------------------------------------------

  app.get('/rms/stock/counts', owner, async (request) => {
    const query = countsQuery.parse(request.query)
    const counts = await request.db.stockCount.findMany({
      where: {
        businessDate: {
          ...(query.from ? { gte: businessDateToUtc(query.from) } : {}),
          ...(query.to ? { lte: businessDateToUtc(query.to) } : {}),
        },
        ...(query.staff ? { staffName: query.staff } : {}),
        ...(query.branch ? { branchName: query.branch } : {}),
      },
      orderBy: [{ businessDate: 'desc' }, { submittedAt: 'desc' }],
      take: 500,
      include: { lines: { select: { unopenedMilli: true, openedMilli: true, balance: true } } },
    })
    return {
      counts: counts.map((count) => ({
        id: count.id,
        businessDate: isoDate(count.businessDate),
        submittedAt: count.submittedAt.toISOString(),
        branchName: count.branchName,
        staffName: count.staffName,
        remarks: count.remarks,
        itemCount: count.lines.length,
        filledCount: count.lines.filter(
          (line) => line.unopenedMilli !== null || line.openedMilli !== null || line.balance !== null,
        ).length,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/rms/stock/counts/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const count = await request.db.stockCount.findUnique({
      where: { id },
      include: { lines: { orderBy: { position: 'asc' } } },
    })
    if (!count) throw notFound('stock:COUNT_NOT_FOUND')
    return {
      count: {
        id: count.id,
        businessDate: isoDate(count.businessDate),
        submittedAt: count.submittedAt.toISOString(),
        branchName: count.branchName,
        staffName: count.staffName,
        remarks: count.remarks,
        lines: count.lines.map((line) => ({
          brandId: line.brandId,
          brandName: line.brandName,
          category: line.category,
          subcategory: line.subcategory,
          name: line.name,
          unitLabel: line.unitLabel,
          trackUnopened: line.trackUnopened,
          trackOpened: line.trackOpened,
          trackBalance: line.trackBalance,
          unopenedMilli: line.unopenedMilli,
          openedMilli: line.openedMilli,
          balance: line.balance,
        })),
      },
    }
  })
}
