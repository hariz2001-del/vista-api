import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import { prisma, type Tx } from '../db.ts'
import { businessDateToUtc, getBusinessDate } from '../domain/business-date.ts'
import { openingDeficitFor, settlePeriod, splitShared } from '../domain/settlement.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { shiftTakings } from './shifts.ts'

/**
 * The owner dashboard: its read model and its write actions. Owner accounts only.
 *
 * Unlike the counter endpoints — snake_case wire contracts shared with an
 * offline device — these are camelCase and shaped exactly like the RMS client
 * types. This model exists for one client, and matching it removes a mapping
 * layer on both sides.
 *
 * Every write is a new row or a guarded state change. Nothing here edits a
 * sale, and no money figure is taken from the browser except what the owner
 * typed themselves (an expense, an adjustment). Settlement is computed here.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const ID = z.string().uuid()

const DEFAULT_SETTINGS = {
  businessName: 'Vista',
  outletName: '',
  sharedOverheadFoodPct: 70,
  hostCommissionPct: 30,
  capitalAssetFoodPct: 50,
}

/** `YYYY-MM-DD` for a Postgres DATE, which Prisma hands back as UTC midnight. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/** Parse a business date, so an impossible one (30 Feb) is a 400, not a 500. */
function toDate(value: string): Date {
  try {
    return businessDateToUtc(value)
  } catch {
    throw badRequest('validation:INVALID_REQUEST', `not a real date: ${value}`)
  }
}

/** No new money row may land inside a period both partners have already settled. */
async function assertNotLocked(client: Tx, businessDate: string): Promise<void> {
  const date = toDate(businessDate)
  const closure = await client.periodClosure.findFirst({
    where: { startDate: { lte: date }, endDate: { gte: date } },
  })
  if (closure) throw conflict('rms:PERIOD_LOCKED')
}

/** Equipment is real money out but not a cost of trading. */
function ledgerCategoryFor(category: string): 'CAPITAL_ASSET' | 'OPERATING_EXPENSE' {
  return category === 'CAPITAL_ASSET' ? 'CAPITAL_ASSET' : 'OPERATING_EXPENSE'
}

const expenseBody = z.object({
  businessDate: DATE,
  amountSen: z.number().int().positive(),
  category: z.enum([
    'RAW_MATERIALS',
    'PACKAGING',
    'RENT',
    'UTILITIES',
    'OPERATIONS',
    'MAINTENANCE',
    'CAPITAL_ASSET',
  ]),
  paidBy: z.enum(['STALL_FUNDS', 'PARTNER_FOOD', 'PARTNER_DRINKS']),
  brandId: ID.nullable(),
  foodSplitPct: z.number().int().min(0).max(100),
  description: z.string().trim().min(1).max(200),
})

const adjustmentBody = z.object({
  businessDate: DATE,
  amountSen: z.number().int().positive(),
  direction: z.enum(['MONEY_IN', 'MONEY_OUT']),
  description: z.string().trim().min(1).max(200),
  shiftId: ID.nullable(),
})

const productBody = z.object({
  basePriceSen: z.number().int().min(0).optional(),
  isSoldOut: z.boolean().optional(),
})

const settingsBody = z.object({
  businessName: z.string().trim().min(1).max(80),
  outletName: z.string().trim().min(1).max(80),
  sharedOverheadFoodPct: z.number().int().min(0).max(100),
  hostCommissionPct: z.number().int().min(0).max(100),
  capitalAssetFoodPct: z.number().int().min(0).max(100),
})

/** Only the window. Any figures a browser sends alongside are stripped and ignored. */
const periodBody = z.object({ startDate: DATE, endDate: DATE })

export async function rmsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  /**
   * Everything the dashboard renders, in one response. The RMS computes running
   * balances and settlements over the full history, so it needs all of it; for
   * a single stall that is small. The dashboard polls this, which is how a sale
   * rung at the counter appears on the owner's screen within seconds.
   */
  app.get('/rms/snapshot', { preHandler: requireOwner }, async () => {
    const [
      settings,
      brands,
      categories,
      products,
      owners,
      shifts,
      orders,
      corrections,
      ledger,
      expenses,
      closures,
      terminal,
    ] = await Promise.all([
      prisma.accountSettings.findUnique({ where: { id: 1 } }),
      prisma.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.category.findMany({ orderBy: [{ brandId: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.product.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.user.findMany({
        where: { role: { in: ['OWNER_FOOD', 'OWNER_DRINKS'] }, isActive: true },
        orderBy: { role: 'asc' },
      }),
      prisma.shift.findMany({ orderBy: { openedAt: 'asc' } }),
      prisma.order.findMany({ orderBy: { completedAt: 'asc' }, include: { items: true } }),
      prisma.saleCorrection.findMany({
        orderBy: { createdAt: 'asc' },
        include: { brandDeltas: true, originalOrder: { select: { queueNumber: true } } },
      }),
      prisma.ledgerEntry.findMany({ orderBy: [{ businessDate: 'asc' }, { id: 'asc' }] }),
      prisma.expense.findMany({ orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }] }),
      prisma.periodClosure.findMany({ orderBy: { endDate: 'asc' } }),
      prisma.terminalStatus.findUnique({ where: { id: 1 } }),
    ])

    // Brands are ordered Food first. The partner roles follow the same order:
    // the Food owner owns the first brand, the host owns the second.
    const [foodBrand, drinksBrand] = brands
    const current = settings ?? DEFAULT_SETTINGS

    return {
      businessDate: getBusinessDate(new Date()),
      settings: {
        businessName: current.businessName,
        outletName: current.outletName,
        sharedOverheadFoodPct: current.sharedOverheadFoodPct,
        hostCommissionPct: current.hostCommissionPct,
        capitalAssetFoodPct: current.capitalAssetFoodPct,
      },
      brands: brands.map((brand) => ({
        id: brand.id,
        name: brand.name,
        colour: brand.colour,
        softColour: brand.softColour,
      })),
      categories: categories.map((category) => ({
        id: category.id,
        brandId: category.brandId,
        name: category.name,
      })),
      products: products.map((product) => ({
        id: product.id,
        brandId: product.brandId,
        categoryId: product.categoryId,
        name: product.name,
        basePriceSen: product.basePriceSen,
        imageUrl: product.imageUrl ?? '',
        isSoldOut: product.isSoldOut,
        isActive: product.isActive,
      })),
      partners: owners.map((owner) => ({
        id: owner.id,
        name: owner.name,
        brandId: (owner.role === 'OWNER_FOOD' ? foodBrand?.id : drinksBrand?.id) ?? '',
        role: owner.role === 'OWNER_FOOD' ? 'FOOD_OWNER' : 'STALL_HOST',
      })),
      shifts: shifts.map((shift) => ({
        id: shift.id,
        businessDate: isoDate(shift.businessDate),
        openedAt: shift.openedAt.toISOString(),
        closedAt: shift.closedAt?.toISOString() ?? null,
        systemNetSalesSen: shift.systemNetSalesSen,
        declaredBankTotalSen: shift.declaredBankTotalSen,
        varianceSen: shift.varianceSen,
        reconciliationStatus: shift.reconciliationStatus,
      })),
      orders: orders.map((order) => ({
        id: order.id,
        shiftId: order.shiftId,
        businessDate: isoDate(order.businessDate),
        queueNumber: order.queueNumber,
        offlineLabel: order.offlineLabel,
        completedAt: order.completedAt.toISOString(),
        grossSen: order.grossSen,
        lineDiscountSen: order.lineDiscountSen,
        orderDiscountSen: order.orderDiscountSen,
        totalAmountSen: order.totalAmountSen,
        flagStatus: order.flagStatus,
        flagReason: order.flagReason,
        needsReview: order.needsReview,
        reviewReason: order.reviewReason,
        lines: order.items.map((item) => ({
          productName: item.productName,
          brandId: item.brandId,
          categoryId: item.categoryId,
          quantity: item.quantity,
          unitPriceSen: item.unitPriceSen,
          modifierTotalSen: item.modifierTotalSen,
          lineDiscountSen: item.lineDiscountSen,
          allocatedOrderDiscountSen: item.allocatedOrderDiscountSen,
        })),
      })),
      corrections: corrections.map((correction) => ({
        id: correction.id,
        originalOrderId: correction.originalOrderId,
        originalQueueNumber: correction.originalOrder.queueNumber,
        shiftId: correction.shiftId,
        businessDate: isoDate(correction.businessDate),
        createdAt: correction.createdAt.toISOString(),
        kind: correction.kind,
        reason: correction.reason,
        deltaSen: correction.deltaSen,
        brandDeltas: correction.brandDeltas.map((delta) => ({
          brandId: delta.brandId,
          deltaSen: delta.deltaSen,
        })),
      })),
      ledger: ledger.map((entry) => ({
        // BIGSERIAL, but a single stall will not pass 2^53 rows.
        id: Number(entry.id),
        businessDate: isoDate(entry.businessDate),
        entryAt: entry.entryAt.toISOString(),
        direction: entry.direction,
        amountSen: entry.amountSen,
        category: entry.category,
        description: entry.description,
        brandId: entry.brandId,
        orderId: entry.orderId,
        shiftId: entry.shiftId,
        correctionId: entry.correctionId,
      })),
      expenses: expenses.map((expense) => ({
        id: expense.id,
        businessDate: isoDate(expense.businessDate),
        amountSen: expense.amountSen,
        category: expense.category,
        paidBy: expense.paidBy,
        brandId: expense.brandId,
        foodSplitPct: expense.foodSplitPct,
        foodAmountSen: expense.foodAmountSen,
        drinksAmountSen: expense.drinksAmountSen,
        description: expense.description,
        receiptUrl: expense.receiptUrl,
        isSettled: expense.isSettled,
        isLocked: expense.isLocked,
      })),
      closures: closures.map((closure) => ({
        id: closure.id,
        startDate: isoDate(closure.startDate),
        endDate: isoDate(closure.endDate),
        closedAt: closure.closedAt.toISOString(),
        foodNetSalesSen: closure.foodNetSalesSen,
        foodDirectExpensesSen: closure.foodDirectExpensesSen,
        foodOverheadShareSen: closure.foodOverheadShareSen,
        foodNetResultSen: closure.foodNetResultSen,
        openingIouSen: closure.openingIouSen,
        hostCommissionSen: closure.hostCommissionSen,
        closingIouSen: closure.closingIouSen,
      })),
      terminal: {
        lastSeenAt: terminal?.lastSeenAt?.toISOString() ?? null,
        consecutiveSyncFailures: terminal?.consecutiveSyncFailures ?? 0,
        // Unknowable from here: a disconnected tablet cannot report what it holds.
        unsentSaleCount: 0,
      },
    }
  })

  // -------------------------------------------------------------------------
  // Expenses
  // -------------------------------------------------------------------------

  /**
   * Log a cost. The food/drinks split is computed here and snapshotted on the
   * row. Only money that left the stall account reaches the ledger; a partner
   * paying out of pocket creates a debt to them instead, settled later.
   */
  app.post('/rms/expenses', { preHandler: requireOwner }, async (request) => {
    const body = expenseBody.parse(request.body)

    return prisma.$transaction(async (tx) => {
      await assertNotLocked(tx, body.businessDate)

      const brands = await tx.brand.findMany({ orderBy: { sortOrder: 'asc' } })
      const foodBrand = brands[0]
      if (body.brandId !== null && !brands.some((brand) => brand.id === body.brandId)) {
        throw badRequest('rms:UNKNOWN_BRAND')
      }

      const isShared = body.brandId === null
      const isFood = body.brandId !== null && body.brandId === foodBrand?.id
      const { foodSen, drinksSen } = isShared
        ? splitShared(body.amountSen, body.foodSplitPct)
        : isFood
          ? { foodSen: body.amountSen, drinksSen: 0 }
          : { foodSen: 0, drinksSen: body.amountSen }

      const expense = await tx.expense.create({
        data: {
          businessDate: toDate(body.businessDate),
          amountSen: body.amountSen,
          category: body.category,
          paidBy: body.paidBy,
          brandId: body.brandId,
          foodSplitPct: isShared ? body.foodSplitPct : isFood ? 100 : 0,
          foodAmountSen: foodSen,
          drinksAmountSen: drinksSen,
          description: body.description,
          isSettled: body.paidBy === 'STALL_FUNDS',
          createdById: request.user.id,
        },
      })

      if (body.paidBy === 'STALL_FUNDS') {
        await tx.ledgerEntry.create({
          data: {
            businessDate: toDate(body.businessDate),
            direction: 'MONEY_OUT',
            amountSen: body.amountSen,
            category: ledgerCategoryFor(body.category),
            description: body.description,
            brandId: body.brandId,
          },
        })
      }

      return { id: expense.id }
    })
  })

  /**
   * Reimburse a partner who paid out of pocket. The flag flips with a guarded
   * update, so a double click or two owners at once cannot pay the same advance
   * twice: the second finds nothing left to settle and is refused.
   */
  app.post<{ Params: { id: string } }>(
    '/rms/expenses/:id/settle',
    { preHandler: requireOwner },
    async (request) => {
      const id = ID.parse(request.params.id)

      return prisma.$transaction(async (tx) => {
        const expense = await tx.expense.findUnique({ where: { id } })
        if (!expense) throw notFound('rms:EXPENSE_NOT_FOUND')
        if (expense.paidBy === 'STALL_FUNDS') throw badRequest('rms:NOT_AN_ADVANCE')

        const today = getBusinessDate(new Date())
        await assertNotLocked(tx, today)

        const flipped = await tx.expense.updateMany({
          where: { id, isSettled: false },
          data: { isSettled: true },
        })
        if (flipped.count === 0) throw conflict('rms:ALREADY_SETTLED')

        await tx.ledgerEntry.create({
          data: {
            businessDate: toDate(today),
            direction: 'MONEY_OUT',
            amountSen: expense.amountSen,
            category: ledgerCategoryFor(expense.category),
            description: `Reimbursed · ${expense.description}`,
            brandId: expense.brandId,
          },
        })

        return { id }
      })
    },
  )

  // -------------------------------------------------------------------------
  // Cash book
  // -------------------------------------------------------------------------

  /**
   * Adjust Balance: one RECONCILIATION_ADJUSTMENT row, nothing else changed.
   * Tying it to a shift only records which close prompted it.
   */
  app.post('/rms/ledger/adjustments', { preHandler: requireOwner }, async (request) => {
    const body = adjustmentBody.parse(request.body)

    return prisma.$transaction(async (tx) => {
      await assertNotLocked(tx, body.businessDate)

      if (body.shiftId !== null) {
        const shift = await tx.shift.findUnique({ where: { id: body.shiftId } })
        if (!shift) throw notFound('shift:NOT_FOUND')
      }

      const entry = await tx.ledgerEntry.create({
        data: {
          businessDate: toDate(body.businessDate),
          direction: body.direction,
          amountSen: body.amountSen,
          category: 'RECONCILIATION_ADJUSTMENT',
          description: body.description,
          shiftId: body.shiftId,
        },
      })

      if (body.shiftId !== null) {
        await tx.shift.update({
          where: { id: body.shiftId },
          data: { reconciliationStatus: 'RECONCILED' },
        })
      }

      return { id: Number(entry.id) }
    })
  })

  // -------------------------------------------------------------------------
  // Shifts
  // -------------------------------------------------------------------------

  /**
   * Close the counter from the dashboard. Takes the same row lock as checkout,
   * so no sale can land between the takings being counted and the close. It
   * cannot lock the tablet itself — the offline-first design has no push channel.
   */
  app.post<{ Params: { id: string } }>(
    '/rms/shifts/:id/force-close',
    { preHandler: requireOwner },
    async (request) => {
      const id = ID.parse(request.params.id)

      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM shifts WHERE id = ${id} FOR UPDATE
        `
        const shift = locked[0]
        if (!shift) throw notFound('shift:NOT_FOUND')
        if (shift.status !== 'OPEN') throw conflict('rms:SHIFT_NOT_OPEN')

        const { systemNetSalesSen } = await shiftTakings(tx, id)
        await tx.shift.update({
          where: { id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closedById: request.user.id,
            declaredBankTotalSen: null,
            systemNetSalesSen,
            varianceSen: null,
            reconciliationStatus: 'NOT_REQUIRED',
          },
        })

        return { id, systemNetSalesSen }
      })
    },
  )

  // -------------------------------------------------------------------------
  // Menu and settings
  // -------------------------------------------------------------------------

  /**
   * Change a price or mark an item sold out. A price change reaches the counter
   * on its next menu refresh; a sale already rung at the old price is recorded
   * at the price charged, never repriced.
   */
  app.patch<{ Params: { id: string } }>(
    '/rms/products/:id',
    { preHandler: requireOwner },
    async (request) => {
      const id = ID.parse(request.params.id)
      const body = productBody.parse(request.body)
      if (body.basePriceSen === undefined && body.isSoldOut === undefined) {
        throw badRequest('rms:NOTHING_TO_CHANGE')
      }

      const product = await prisma.product.findUnique({ where: { id } })
      if (!product) throw notFound('rms:PRODUCT_NOT_FOUND')

      await prisma.product.update({
        where: { id },
        data: {
          ...(body.basePriceSen === undefined ? {} : { basePriceSen: body.basePriceSen }),
          ...(body.isSoldOut === undefined ? {} : { isSoldOut: body.isSoldOut }),
        },
      })
      return { id }
    },
  )

  /**
   * The business profile and partner split. Changing a percentage affects only
   * what is logged from now on: each expense keeps the split it was logged with.
   */
  app.put('/rms/settings', { preHandler: requireOwner }, async (request) => {
    const body = settingsBody.parse(request.body)
    await prisma.accountSettings.upsert({
      where: { id: 1 },
      update: body,
      create: { id: 1, ...body },
    })
    return body
  })

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /**
   * Freeze a period at figures computed here, from the database.
   *
   * The browser sends only the window. Refuses while a shift in it is still
   * open, or if any part of it is already settled — the exclusion constraint on
   * `period_closures` makes an overlap impossible regardless.
   */
  app.post('/rms/periods/close', { preHandler: requireOwner }, async (request) => {
    const body = periodBody.parse(request.body)
    if (body.startDate > body.endDate) throw badRequest('rms:INVALID_RANGE')
    const start = toDate(body.startDate)
    const end = toDate(body.endDate)
    const inWindow = { gte: start, lte: end }

    return prisma.$transaction(async (tx) => {
      // One close at a time, so a race becomes a clean refusal rather than a
      // constraint error.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(7041)) AS held`

      const overlap = await tx.periodClosure.findFirst({
        where: { startDate: { lte: end }, endDate: { gte: start } },
      })
      if (overlap) throw conflict('rms:PERIOD_OVERLAPS')

      const openShifts = await tx.shift.count({
        where: { status: 'OPEN', businessDate: inWindow },
      })
      if (openShifts > 0) throw conflict('rms:SHIFT_STILL_OPEN')

      const [brands, settings, lines, corrections, expenses, advances, drawings, closures] =
        await Promise.all([
          tx.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
          tx.accountSettings.findUnique({ where: { id: 1 } }),
          tx.orderItem.findMany({ where: { order: { businessDate: inWindow } } }),
          tx.saleCorrection.findMany({
            where: { businessDate: inWindow },
            include: { brandDeltas: true },
          }),
          tx.expense.findMany({ where: { businessDate: inWindow } }),
          tx.expense.findMany({ where: { paidBy: { not: 'STALL_FUNDS' }, isSettled: false } }),
          tx.ledgerEntry.findMany({
            where: { businessDate: inWindow, category: 'OWNER_DRAWING' },
          }),
          tx.periodClosure.findMany(),
        ])

      const [foodBrand, drinksBrand] = brands
      if (!foodBrand || !drinksBrand) throw badRequest('rms:UNKNOWN_BRAND')

      const summary = settlePeriod({
        orderLines: lines,
        corrections,
        expenses,
        outstandingAdvances: advances,
        ledger: drawings,
        hostCommissionPct: (settings ?? DEFAULT_SETTINGS).hostCommissionPct,
        foodBrandId: foodBrand.id,
        drinksBrandId: drinksBrand.id,
        openingIouSen: openingDeficitFor(
          closures.map((closure) => ({
            endDate: isoDate(closure.endDate),
            closingIouSen: closure.closingIouSen,
          })),
          body.startDate,
        ),
      })

      await tx.periodClosure.create({
        data: {
          startDate: start,
          endDate: end,
          closedById: request.user.id,
          foodNetSalesSen: summary.food.netSalesSen,
          foodDirectExpensesSen: summary.food.directExpensesSen,
          foodOverheadShareSen: summary.food.sharedOverheadShareSen,
          foodNetResultSen: summary.food.netResultSen,
          openingIouSen: summary.openingIouSen,
          hostCommissionSen: summary.hostCommissionSen,
          closingIouSen: summary.closingIouSen,
          foodPayoutSen: summary.foodPayoutSen,
          drinksPayoutSen: summary.drinksPayoutSen,
        },
      })

      await tx.order.updateMany({ where: { businessDate: inWindow }, data: { isLocked: true } })
      await tx.expense.updateMany({ where: { businessDate: inWindow }, data: { isLocked: true } })
      // Every outstanding advance is in the payouts above, so none carries into
      // the next period as still owed.
      await tx.expense.updateMany({
        where: { paidBy: { not: 'STALL_FUNDS' }, isSettled: false },
        data: { isSettled: true },
      })

      return summary
    })
  })
}
