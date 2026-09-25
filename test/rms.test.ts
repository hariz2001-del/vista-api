import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import {
  authed,
  checkoutPayload,
  correctionPayload,
  DEMO,
  login,
  loginOwner,
  makeApp,
  openShift,
  productByName,
  resetTransactional,
} from './helpers.ts'

let app: FastifyInstance
let cashierToken: string
let ownerToken: string
let shiftId: string
const businessDate = getBusinessDate(new Date())

beforeAll(async () => {
  app = await makeApp()
  cashierToken = await login(app)
  ownerToken = await loginOwner(app)
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetTransactional()
  shiftId = await openShift(app, cashierToken)
})

// Snapshot shapes, only as far as these tests read them.
type Snapshot = {
  businessDate: string
  partners: Array<{ name: string; brandId: string; role: string }>
  brands: Array<{ id: string; name: string }>
  orders: Array<{ queueNumber: string; totalAmountSen: number; lines: unknown[] }>
  corrections: Array<{ kind: string; deltaSen: number; originalQueueNumber: string; reason: string }>
  ledger: Array<{ category: string; direction: string; amountSen: number; description: string }>
  expenses: Array<{ id: string; isSettled: boolean; foodAmountSen: number; drinksAmountSen: number }>
  shifts: Array<{ id: string; closedAt: string | null; systemNetSalesSen: number | null; reconciliationStatus: string }>
  closures: Array<{ foodNetSalesSen: number; hostCommissionSen: number }>
  terminal: { lastSeenAt: string | null; consecutiveSyncFailures: number }
  settings: { hostCommissionPct: number }
}

async function snapshot(): Promise<Snapshot> {
  const response = await app.inject({
    method: 'GET',
    url: '/rms/snapshot',
    headers: authed(ownerToken),
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Snapshot
}

function asOwner(method: 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: authed(ownerToken), payload: payload as object })
}

/** Ring a sale at the counter, as the POS does. */
async function sell(names: string[], claimedTotalSen: number) {
  const items = await Promise.all(
    names.map(async (name) => ({ product_id: (await productByName(name)).id, quantity: 1 })),
  )
  const clientTxnId = randomUUID()
  const response = await app.inject({
    method: 'POST',
    url: '/checkout',
    headers: authed(cashierToken),
    payload: checkoutPayload({ shiftId, businessDate, clientTxnId, claimedTotalSen, items }),
  })
  expect(response.statusCode).toBe(200)
  return clientTxnId
}

async function closeShiftAtCounter() {
  const response = await app.inject({
    method: 'POST',
    url: `/shifts/${shiftId}/close`,
    headers: authed(cashierToken),
    payload: { pin: DEMO.pin },
  })
  expect(response.statusCode).toBe(200)
}

describe('rms — access', () => {
  it('refuses a counter session of the same account, even with a valid token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/rms/snapshot',
      headers: authed(cashierToken),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'auth:FORBIDDEN' })
  })

  it('refuses a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/rms/snapshot' })
    expect(response.statusCode).toBe(401)
  })
})

describe('rms — what the counter did shows up for the owner', () => {
  it('shows a sale rung at the counter, its lines and its revenue rows', async () => {
    // Food 800 + Drinks 400.
    await sell(['Ayam Goreng Berempah', 'Teh O Ais Limau'], 1200)

    const books = await snapshot()
    expect(books.orders).toHaveLength(1)
    expect(books.orders[0]).toMatchObject({ queueNumber: '#001', totalAmountSen: 1200 })
    expect(books.orders[0]?.lines).toHaveLength(2)

    const revenue = books.ledger.filter((entry) => entry.category === 'REVENUE')
    expect(revenue.reduce((sum, entry) => sum + entry.amountSen, 0)).toBe(1200)
  })

  it('shows a cashier cancel as a correction and refund rows, beside the untouched sale', async () => {
    const original = await sell(['Ayam Goreng Berempah'], 800)
    const cancel = await app.inject({
      method: 'POST',
      url: '/corrections',
      headers: authed(cashierToken),
      payload: correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original,
        kind: 'CANCEL',
        reason: 'Customer cancelled after paying',
        claimedDeltaSen: -800,
      }),
    })
    expect(cancel.statusCode).toBe(200)

    const books = await snapshot()
    expect(books.orders[0]?.totalAmountSen).toBe(800)
    expect(books.corrections).toEqual([
      expect.objectContaining({
        kind: 'CANCEL',
        deltaSen: -800,
        originalQueueNumber: '#001',
        reason: 'Customer cancelled after paying',
      }),
    ])
    expect(books.ledger.filter((entry) => entry.category === 'REFUND')).toHaveLength(1)
  })

  it('names the partners from the partners table, in brand order', async () => {
    const books = await snapshot()
    const [food, drinks] = books.brands
    expect(books.partners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Hariz', role: 'FOOD_OWNER', brandId: food?.id }),
        expect.objectContaining({ name: 'Iman', role: 'STALL_HOST', brandId: drinks?.id }),
      ]),
    )
  })

  it('shows the counter heartbeat as the last time the tablet was seen', async () => {
    expect((await snapshot()).terminal.lastSeenAt).toBeNull()

    const beat = await app.inject({
      method: 'POST',
      url: '/terminal/heartbeat',
      headers: authed(cashierToken),
      payload: { consecutive_sync_failures: 2 },
    })
    expect(beat.statusCode).toBe(200)

    const { terminal } = await snapshot()
    expect(terminal.lastSeenAt).not.toBeNull()
    expect(terminal.consecutiveSyncFailures).toBe(2)
  })
})

describe('rms — expenses', () => {
  it('writes one ledger outflow for a stall-funded expense, split and snapshotted', async () => {
    const response = await asOwner('POST', '/rms/expenses', {
      businessDate,
      amountSen: 5000,
      category: 'RENT',
      paidBy: 'STALL_FUNDS',
      brandId: null,
      foodSplitPct: 70,
      description: 'Stall rent',
    })
    expect(response.statusCode).toBe(200)

    const books = await snapshot()
    expect(books.expenses[0]).toMatchObject({ foodAmountSen: 3500, drinksAmountSen: 1500, isSettled: true })
    expect(books.ledger.filter((entry) => entry.category === 'OPERATING_EXPENSE')).toEqual([
      expect.objectContaining({ direction: 'MONEY_OUT', amountSen: 5000 }),
    ])
  })

  it('records a partner advance as a debt, and pays it out once — never twice', async () => {
    await asOwner('POST', '/rms/expenses', {
      businessDate,
      amountSen: 1000,
      category: 'MAINTENANCE',
      paidBy: 'PARTNER_DRINKS',
      brandId: null,
      foodSplitPct: 70,
      description: 'Exhaust fan repair',
    })

    let books = await snapshot()
    const advance = books.expenses[0]
    expect(advance?.isSettled).toBe(false)
    // Money never left the stall account, so nothing is in the ledger yet.
    expect(books.ledger).toHaveLength(0)

    const first = await asOwner('POST', `/rms/expenses/${advance?.id}/settle`)
    const second = await asOwner('POST', `/rms/expenses/${advance?.id}/settle`)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: 'rms:ALREADY_SETTLED' })

    books = await snapshot()
    expect(books.ledger).toEqual([
      expect.objectContaining({ direction: 'MONEY_OUT', amountSen: 1000, description: 'Reimbursed · Exhaust fan repair' }),
    ])
  })
})

describe('rms — cash book and shifts', () => {
  it('writes exactly one adjustment and marks the shift it was tied to', async () => {
    const response = await asOwner('POST', '/rms/ledger/adjustments', {
      businessDate,
      amountSen: 1850,
      direction: 'MONEY_OUT',
      description: 'Bank transfer fee',
      shiftId,
    })
    expect(response.statusCode).toBe(200)

    const books = await snapshot()
    expect(books.ledger).toEqual([
      expect.objectContaining({ category: 'RECONCILIATION_ADJUSTMENT', amountSen: 1850 }),
    ])
    expect(books.shifts.find((shift) => shift.id === shiftId)?.reconciliationStatus).toBe('RECONCILED')
  })

  it('force-closes the counter with takings the server counts itself', async () => {
    await sell(['Ayam Goreng Berempah'], 800)

    const response = await asOwner('POST', `/rms/shifts/${shiftId}/force-close`)
    expect(response.statusCode).toBe(200)

    const shift = (await snapshot()).shifts.find((candidate) => candidate.id === shiftId)
    expect(shift?.closedAt).not.toBeNull()
    expect(shift?.systemNetSalesSen).toBe(800)

    const again = await asOwner('POST', `/rms/shifts/${shiftId}/force-close`)
    expect(again.statusCode).toBe(409)
  })
})

describe('rms — menu and settings', () => {
  it('changes a price and a sold-out flag, and the counter menu follows', async () => {
    const product = await productByName('Ayam Goreng Berempah')
    try {
      const response = await asOwner('PATCH', `/rms/products/${product.id}`, {
        basePriceSen: 850,
        isSoldOut: true,
      })
      expect(response.statusCode).toBe(200)

      const menu = await app.inject({ method: 'GET', url: '/bootstrap', headers: authed(cashierToken) })
      const item = (menu.json() as { products: Array<{ id: string; unit_price_sen: number; sold_out: boolean }> })
        .products.find((candidate) => candidate.id === product.id)
      expect(item).toMatchObject({ unit_price_sen: 850, sold_out: true })
    } finally {
      // Other suites assert against the seeded price.
      await prisma.product.update({
        where: { id: product.id },
        data: { basePriceSen: product.basePriceSen, isSoldOut: product.isSoldOut },
      })
    }
  })

  it('refuses a split outside 0–100 and saves a valid one', async () => {
    const before = await prisma.accountSettings.findUniqueOrThrow({
      where: { businessId: DEMO.businessId },
    })
    const valid = {
      businessName: before.businessName,
      outletName: before.outletName,
      sharedOverheadFoodPct: 60,
      hostCommissionPct: 25,
      capitalAssetFoodPct: 50,
    }
    try {
      const bad = await asOwner('PUT', '/rms/settings', { ...valid, hostCommissionPct: 150 })
      expect(bad.statusCode).toBe(400)

      const good = await asOwner('PUT', '/rms/settings', valid)
      expect(good.statusCode).toBe(200)
      expect((await snapshot()).settings.hostCommissionPct).toBe(25)
    } finally {
      await prisma.accountSettings.update({
        where: { businessId: DEMO.businessId },
        data: {
          sharedOverheadFoodPct: before.sharedOverheadFoodPct,
          hostCommissionPct: before.hostCommissionPct,
          capitalAssetFoodPct: before.capitalAssetFoodPct,
        },
      })
    }
  })
})

describe('rms — settling a period', () => {
  it('refuses while a shift in the period is still open', async () => {
    const response = await asOwner('POST', '/rms/periods/close', {
      startDate: businessDate,
      endDate: businessDate,
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'rms:SHIFT_STILL_OPEN' })
  })

  it('computes the payout itself, nets out a refunded sale, and ignores figures the browser sends', async () => {
    // Food 800 + Drinks 400, then a second Food 800 that is cancelled at the counter.
    await sell(['Ayam Goreng Berempah', 'Teh O Ais Limau'], 1200)
    const cancelled = await sell(['Ayam Goreng Berempah'], 800)
    await app.inject({
      method: 'POST',
      url: '/corrections',
      headers: authed(cashierToken),
      payload: correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: cancelled,
        kind: 'CANCEL',
        claimedDeltaSen: -800,
      }),
    })
    await closeShiftAtCounter()

    const response = await asOwner('POST', '/rms/periods/close', {
      startDate: businessDate,
      endDate: businessDate,
      // A tampered client claiming a huge payout. Stripped and never read.
      foodPayoutSen: 999_999,
    })
    expect(response.statusCode).toBe(200)

    const summary = response.json() as {
      food: { netSalesSen: number }
      drinks: { netSalesSen: number }
      hostCommissionSen: number
      foodPayoutSen: number
      drinksPayoutSen: number
    }
    // The refunded 800 is not paid out: Food nets 800, not 1,600.
    expect(summary.food.netSalesSen).toBe(800)
    expect(summary.drinks.netSalesSen).toBe(400)
    // Host takes 30% of Food's 800.
    expect(summary.hostCommissionSen).toBe(240)
    expect(summary.foodPayoutSen).toBe(560)
    expect(summary.drinksPayoutSen).toBe(640)

    const stored = await prisma.periodClosure.findFirstOrThrow()
    expect(stored.foodPayoutSen).toBe(560)
    expect(await prisma.order.count({ where: { isLocked: false } })).toBe(0)

    // Settled once. The same days cannot be settled again, and nothing new may
    // be booked into them.
    const again = await asOwner('POST', '/rms/periods/close', {
      startDate: businessDate,
      endDate: businessDate,
    })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: 'rms:PERIOD_OVERLAPS' })

    const lateExpense = await asOwner('POST', '/rms/expenses', {
      businessDate,
      amountSen: 100,
      category: 'OPERATIONS',
      paidBy: 'STALL_FUNDS',
      brandId: null,
      foodSplitPct: 70,
      description: 'Too late',
    })
    expect(lateExpense.statusCode).toBe(409)
    expect(lateExpense.json()).toMatchObject({ error: 'rms:PERIOD_LOCKED' })
  })
})
