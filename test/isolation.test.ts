import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
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
  makeBusiness,
  openShift,
  productByName,
  resetTransactional,
  type TestBusiness,
} from './helpers.ts'

/**
 * Two businesses on one database, and nothing crossing between them.
 *
 * "A" is the seeded demo business; "B" registers through vistahub.my's front
 * door like any new owner. Every test here has B reach for something of A's —
 * by id, by transaction id, by raw foreign key — and expects to find nothing.
 */

let app: FastifyInstance
const businessDate = getBusinessDate(new Date())

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await resetTransactional()
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetTransactional()
})

function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: authed(token), ...(payload ? { payload } : {}) })
}

type Snapshot = {
  settings: { businessName: string; settlementEnabled: boolean }
  brands: Array<{ id: string; name: string }>
  categories: Array<{ id: string; brandId: string }>
  products: Array<{ id: string; name: string }>
  orders: Array<{ id: string; queueNumber: string }>
  expenses: Array<{ id: string; foodAmountSen: number; drinksAmountSen: number }>
  shifts: Array<{ id: string }>
  partners: Array<{ id: string }>
  counterSessions: unknown[]
}

async function snapshotOf(token: string): Promise<Snapshot> {
  const response = await call(token, 'GET', '/rms/snapshot')
  expect(response.statusCode).toBe(200)
  return response.json() as Snapshot
}

/** Give B a one-item menu and return the item's id. */
async function stockMenu(b: TestBusiness, priceSen = 500): Promise<string> {
  const snapshot = await snapshotOf(b.ownerToken)
  const category = snapshot.categories[0]
  if (!category) throw new Error('a new business should start with a category')
  const created = await call(b.ownerToken, 'POST', '/rms/products', {
    categoryId: category.id,
    name: 'Kuih Lapis',
    basePriceSen: priceSen,
  })
  expect(created.statusCode).toBe(200)
  return (created.json() as { id: string }).id
}

async function sell(token: string, shiftId: string, productId: string, totalSen: number) {
  const clientTxnId = randomUUID()
  const response = await call(
    token,
    'POST',
    '/checkout',
    checkoutPayload({
      shiftId,
      businessDate,
      clientTxnId,
      claimedTotalSen: totalSen,
      items: [{ product_id: productId, quantity: 1 }],
    }),
  )
  return { response, clientTxnId }
}

describe('registration', () => {
  it('creates a business with its own empty menu, settlement off', async () => {
    const b = await makeBusiness(app, 'Kedai Kopi Baru')
    const snapshot = await snapshotOf(b.ownerToken)

    expect(snapshot.settings).toMatchObject({
      businessName: 'Kedai Kopi Baru',
      settlementEnabled: false,
    })
    expect(snapshot.brands.map((brand) => brand.name)).toEqual(['Kedai Kopi Baru'])
    expect(snapshot.categories).toHaveLength(1)
    expect(snapshot.products).toEqual([])
    expect(snapshot.partners).toEqual([])

    // The counter sees the same business.
    const bootstrap = await call(b.counterToken, 'GET', '/bootstrap')
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json()).toMatchObject({ business_id: b.businessId, products: [] })
  })

  it('refuses an email that is already registered, including the demo one', async () => {
    const b = await makeBusiness(app)
    for (const email of [b.email, DEMO.email, DEMO.email.toUpperCase()]) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { businessName: 'Copycat', email, password: 'another long password', pin: '1234' },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'auth:EMAIL_TAKEN' })
    }
    expect(await prisma.business.count({ where: { name: 'Copycat' } })).toBe(0)
  })

  it('refuses a short password and a PIN that is not four digits', async () => {
    const base = { businessName: 'Weak', email: `weak.${Date.now()}@example.test` }
    for (const bad of [
      { ...base, password: 'short', pin: '1234' },
      { ...base, password: 'long enough password', pin: '12a4' },
      { ...base, password: 'long enough password', pin: '12345' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/auth/register', payload: bad })
      expect(response.statusCode).toBe(400)
    }
  })

  it('signs in afterwards with the password it registered with', async () => {
    const b = await makeBusiness(app)
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: b.email, password: b.password, scope: 'OWNER' },
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('hub sessions and handoff', () => {
  async function hubToken(b: TestBusiness): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: b.email, password: b.password, scope: 'HUB' },
    })
    expect(response.statusCode).toBe(200)
    return (response.json() as { token: string }).token
  }

  it('lets a hub session mint a code and do nothing else', async () => {
    const b = await makeBusiness(app)
    const hub = await hubToken(b)

    expect((await call(hub, 'GET', '/bootstrap')).statusCode).toBe(403)
    expect((await call(hub, 'GET', '/rms/snapshot')).statusCode).toBe(403)
    expect((await call(hub, 'POST', '/shifts/open', { pin: b.pin })).statusCode).toBe(403)
    expect((await call(hub, 'POST', '/auth/handoff', { target: 'RMS' })).statusCode).toBe(200)
  })

  it('does not let a counter or owner session mint a code', async () => {
    const b = await makeBusiness(app)
    for (const token of [b.counterToken, b.ownerToken]) {
      expect((await call(token, 'POST', '/auth/handoff', { target: 'RMS' })).statusCode).toBe(403)
    }
  })

  it('opens the RMS as an owner and the POS as a counter', async () => {
    const b = await makeBusiness(app)
    expect((await call(b.ownerToken, 'GET', '/rms/snapshot')).statusCode).toBe(200)
    expect((await call(b.counterToken, 'GET', '/rms/snapshot')).statusCode).toBe(403)
    expect((await call(b.counterToken, 'GET', '/bootstrap')).statusCode).toBe(200)
  })

  it('spends a code once, and not after its minute', async () => {
    const b = await makeBusiness(app)
    const hub = await hubToken(b)
    const mint = async () =>
      ((await call(hub, 'POST', '/auth/handoff', { target: 'POS' })).json() as { code: string })
        .code
    const redeem = (code: string) =>
      app.inject({ method: 'POST', url: '/auth/handoff/redeem', payload: { code } })

    const once = await mint()
    expect((await redeem(once)).statusCode).toBe(200)
    const again = await redeem(once)
    expect(again.statusCode).toBe(401)
    expect(again.json()).toMatchObject({ error: 'auth:HANDOFF_INVALID' })

    const stale = await mint()
    await prisma.handoffCode.updateMany({
      where: { usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })
    expect((await redeem(stale)).statusCode).toBe(401)

    expect((await redeem('not-a-real-code-at-all-1234567890')).statusCode).toBe(401)
  })

  it('stores only a hash of the code', async () => {
    const b = await makeBusiness(app)
    const hub = await hubToken(b)
    const { code } = (await call(hub, 'POST', '/auth/handoff', { target: 'RMS' })).json() as {
      code: string
    }
    expect(await prisma.handoffCode.count({ where: { codeHash: code } })).toBe(0)
  })
})

describe('separate books', () => {
  it('keeps each business to its own menu, sales and snapshot', async () => {
    const aCounter = await login(app)
    const aOwner = await loginOwner(app)
    const b = await makeBusiness(app)

    const bProduct = await stockMenu(b, 500)
    const aShift = await openShift(app, aCounter)
    const bShift = await openShift(app, b.counterToken, b.pin)

    const aProduct = await productByName('Ayam Goreng Berempah') // 800
    const aSale = await sell(aCounter, aShift, aProduct.id, 800)
    const bSale = await sell(b.counterToken, bShift, bProduct, 500)
    expect(aSale.response.statusCode).toBe(200)
    expect(bSale.response.statusCode).toBe(200)

    // Queue numbers restart per business: both are the first sale of their day.
    expect(aSale.response.json()).toMatchObject({ queue_number: '#001' })
    expect(bSale.response.json()).toMatchObject({ queue_number: '#001' })

    const aBooks = await snapshotOf(aOwner)
    const bBooks = await snapshotOf(b.ownerToken)
    expect(aBooks.orders).toHaveLength(1)
    expect(bBooks.orders).toHaveLength(1)
    expect(aBooks.products.some((product) => product.id === bProduct)).toBe(false)
    expect(bBooks.products.map((product) => product.id)).toEqual([bProduct])
    expect(bBooks.shifts.map((shift) => shift.id)).toEqual([bShift])

    // B's counter sees B's menu only.
    const bootstrap = (await call(b.counterToken, 'GET', '/bootstrap')).json() as {
      products: Array<{ id: string }>
      open_shift: { id: string }
    }
    expect(bootstrap.products.map((product) => product.id)).toEqual([bProduct])
    expect(bootstrap.open_shift.id).toBe(bShift)
  })

  it('will not sell another business’s product, or into its shift', async () => {
    const aCounter = await login(app)
    const b = await makeBusiness(app)
    const bProduct = await stockMenu(b)
    const aShift = await openShift(app, aCounter)
    const bShift = await openShift(app, b.counterToken, b.pin)
    const aProduct = await productByName('Ayam Goreng Berempah')

    const foreignProduct = await sell(b.counterToken, bShift, aProduct.id, 800)
    expect(foreignProduct.response.statusCode).toBe(400)
    expect(foreignProduct.response.json()).toMatchObject({ error: 'checkout:UNKNOWN_PRODUCT' })

    const foreignShift = await sell(b.counterToken, aShift, bProduct, 500)
    expect(foreignShift.response.statusCode).toBe(404)
    expect(foreignShift.response.json()).toMatchObject({ error: 'shift:NOT_FOUND' })

    expect(await prisma.order.count({ where: { shiftId: aShift } })).toBe(0)
  })

  it('never answers a replayed transaction id with another business’s sale', async () => {
    const aCounter = await login(app)
    const b = await makeBusiness(app)
    const bProduct = await stockMenu(b)
    const aShift = await openShift(app, aCounter)
    const bShift = await openShift(app, b.counterToken, b.pin)
    const aSale = await sell(aCounter, aShift, (await productByName('Ayam Goreng Berempah')).id, 800)

    const replay = await call(
      b.counterToken,
      'POST',
      '/checkout',
      checkoutPayload({
        shiftId: bShift,
        businessDate,
        clientTxnId: aSale.clientTxnId,
        claimedTotalSen: 500,
        items: [{ product_id: bProduct, quantity: 1 }],
      }),
    )
    expect(replay.statusCode).toBe(409)
    expect(replay.json()).toMatchObject({ error: 'checkout:DUPLICATE_TRANSACTION' })
    expect(replay.body).not.toContain((aSale.response.json() as { order_id: string }).order_id)
  })

  it('will not correct another business’s sale', async () => {
    const aCounter = await login(app)
    const b = await makeBusiness(app)
    await stockMenu(b)
    const aShift = await openShift(app, aCounter)
    await openShift(app, b.counterToken, b.pin)
    const aSale = await sell(aCounter, aShift, (await productByName('Ayam Goreng Berempah')).id, 800)

    const response = await call(
      b.counterToken,
      'POST',
      '/corrections',
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: aSale.clientTxnId,
        kind: 'CANCEL',
        claimedDeltaSen: -800,
      }),
    )
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: 'correction:ORDER_NOT_FOUND' })
    expect(await prisma.saleCorrection.count()).toBe(0)
  })

  it('treats every id of another business as not found from the dashboard', async () => {
    const aCounter = await login(app)
    const aOwner = await loginOwner(app)
    const b = await makeBusiness(app)
    const aShift = await openShift(app, aCounter)
    const aProduct = await productByName('Ayam Goreng Berempah')
    const aBrand = aProduct.brandId

    const advance = await call(aOwner, 'POST', '/rms/expenses', {
      businessDate,
      amountSen: 1000,
      category: 'PACKAGING',
      paidBy: 'PARTNER_FOOD',
      brandId: null,
      foodSplitPct: 50,
      description: 'Cups',
    })
    expect(advance.statusCode).toBe(200)
    const aExpense = (advance.json() as { id: string }).id
    const aPartner = await prisma.partner.findFirstOrThrow({
      where: { businessId: DEMO.businessId },
    })

    const attempts = [
      call(b.ownerToken, 'PATCH', `/rms/products/${aProduct.id}`, { basePriceSen: 1 }),
      call(b.ownerToken, 'DELETE', `/rms/products/${aProduct.id}`),
      call(b.ownerToken, 'POST', `/rms/expenses/${aExpense}/settle`),
      call(b.ownerToken, 'POST', `/rms/shifts/${aShift}/force-close`),
      call(b.ownerToken, 'PUT', `/rms/partners/${aPartner.id}`, { name: 'Taken over' }),
      call(b.ownerToken, 'PATCH', `/rms/brands/${aBrand}`, { name: 'Taken over' }),
      call(b.ownerToken, 'POST', '/rms/categories', { brandId: aBrand, name: 'Sneaky' }),
      call(b.ownerToken, 'POST', '/rms/ledger/adjustments', {
        businessDate,
        amountSen: 100,
        direction: 'MONEY_OUT',
        description: 'Sneaky',
        shiftId: aShift,
      }),
    ]
    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode, response.body).toBe(404)
    }

    // And nothing of A's moved.
    const product = await prisma.product.findUniqueOrThrow({ where: { id: aProduct.id } })
    expect(product.basePriceSen).toBe(aProduct.basePriceSen)
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: aExpense } })).isSettled).toBe(false)
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: aShift } })).status).toBe('OPEN')
    expect((await prisma.partner.findUniqueOrThrow({ where: { id: aPartner.id } })).name).toBe(
      aPartner.name,
    )
    expect(
      await prisma.ledgerEntry.count({ where: { businessId: DEMO.businessId, shiftId: aShift } }),
    ).toBe(0)

    // B's own books never show A's expense.
    expect((await snapshotOf(b.ownerToken)).expenses).toEqual([])
  })

  it('lets each business keep a shift open at the same time', async () => {
    const aCounter = await login(app)
    const b = await makeBusiness(app)
    await openShift(app, aCounter)
    await openShift(app, b.counterToken, b.pin)
    expect(await prisma.shift.count({ where: { status: 'OPEN' } })).toBe(2)
  })

  it('signs out only its own counter', async () => {
    const aCounter = await login(app)
    const b = await makeBusiness(app)

    const signOut = await call(b.ownerToken, 'POST', '/rms/counter/sign-out')
    expect(signOut.statusCode).toBe(200)

    expect((await call(b.counterToken, 'GET', '/bootstrap')).statusCode).toBe(401)
    expect((await call(aCounter, 'GET', '/bootstrap')).statusCode).toBe(200)
  })

  it('checks each business’s PIN against its own account', async () => {
    const b = await makeBusiness(app)
    // The demo PIN opens nothing at B, unless it happens to be B's too.
    if (DEMO.pin !== b.pin) {
      const response = await call(b.counterToken, 'POST', '/shifts/open', { pin: DEMO.pin })
      expect(response.statusCode).toBe(401)
    }
  })
})

describe('the database as a backstop', () => {
  it('refuses a row that points at another business’s rows', async () => {
    const b = await makeBusiness(app)
    await stockMenu(b)
    const bShift = await openShift(app, b.counterToken, b.pin)
    const aProduct = await productByName('Ayam Goreng Berempah')
    const bUser = await prisma.user.findUniqueOrThrow({ where: { email: b.email } })

    // Straight through Prisma, past every route: an order of B's carrying a
    // line for A's product. The composite foreign key refuses it.
    const write = prisma.order.create({
      data: {
        businessId: b.businessId,
        shiftId: bShift,
        businessDate: new Date(`${businessDate}T00:00:00.000Z`),
        queueNumber: '#999',
        clientTxnId: randomUUID(),
        grossSen: 800,
        totalAmountSen: 800,
        menuPriceSen: 800,
        confirmedById: bUser.id,
        confirmedAt: new Date(),
        completedAt: new Date(),
        items: {
          create: [
            {
              productId: aProduct.id,
              brandId: aProduct.brandId,
              categoryId: aProduct.categoryId,
              productName: aProduct.name,
              unitPriceSen: 800,
            },
          ],
        },
      },
    })
    await expect(write).rejects.toSatisfy(
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
    )

    // A ledger entry of B's against A's brand, likewise.
    await expect(
      prisma.ledgerEntry.create({
        data: {
          businessId: b.businessId,
          businessDate: new Date(`${businessDate}T00:00:00.000Z`),
          direction: 'MONEY_IN',
          amountSen: 100,
          category: 'REVENUE',
          description: 'cross-business',
          brandId: aProduct.brandId,
        },
      }),
    ).rejects.toSatisfy(
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
    )
  })
})

describe('routes', () => {
  it('reach the database only through the business-scoped client', () => {
    // Sign-in and registration run before there is a business; every other
    // route must go through `request.db`. A bare `prisma` import in a route
    // file is how one business's query would reach another's rows.
    const dir = join(import.meta.dirname, '..', 'src', 'routes')
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && file !== 'auth.ts')
      .filter((file) => /import\s*\{[^}]*\bprisma\b[^}]*\}\s*from\s*'\.\.\/db\.ts'/.test(
        readFileSync(join(dir, file), 'utf8'),
      ))
    expect(offenders).toEqual([])
  })

  it('filter every raw query on the business', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'routes')
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const raw of source.matchAll(/\$(?:queryRaw|executeRaw)`([^`]*)`/g)) {
        expect(raw[1], `${file}: ${raw[1]}`).toMatch(/business_id|businessId/)
      }
    }
  })
})

describe('partner settlement', () => {
  it('is off for a new business, and refuses what only settlement uses', async () => {
    const b = await makeBusiness(app)

    const advance = await call(b.ownerToken, 'POST', '/rms/expenses', {
      businessDate,
      amountSen: 1000,
      category: 'PACKAGING',
      paidBy: 'PARTNER_FOOD',
      brandId: null,
      foodSplitPct: 50,
      description: 'Cups',
    })
    expect(advance.statusCode).toBe(400)
    expect(advance.json()).toMatchObject({ error: 'rms:SETTLEMENT_OFF' })

    const close = await call(b.ownerToken, 'POST', '/rms/periods/close', {
      startDate: businessDate,
      endDate: businessDate,
    })
    expect(close.statusCode).toBe(400)
    expect(close.json()).toMatchObject({ error: 'rms:SETTLEMENT_OFF' })

    // A plain cost from the business's own funds is fine, and is not split.
    const cost = await call(b.ownerToken, 'POST', '/rms/expenses', {
      businessDate,
      amountSen: 1000,
      category: 'PACKAGING',
      paidBy: 'STALL_FUNDS',
      brandId: null,
      foodSplitPct: 50,
      description: 'Cups',
    })
    expect(cost.statusCode).toBe(200)
    expect((await snapshotOf(b.ownerToken)).expenses).toMatchObject([
      { foodAmountSen: 1000, drinksAmountSen: 0 },
    ])
  })

  it('switches on only with two brands, and names a partner for each', async () => {
    const b = await makeBusiness(app, 'Two Brands')
    const settings = {
      businessName: 'Two Brands',
      outletName: 'Two Brands',
      settlementEnabled: true,
      sharedOverheadFoodPct: 60,
      hostCommissionPct: 20,
      capitalAssetFoodPct: 50,
    }

    const tooFew = await call(b.ownerToken, 'PUT', '/rms/settings', settings)
    expect(tooFew.statusCode).toBe(400)
    expect(tooFew.json()).toMatchObject({ error: 'rms:SETTLEMENT_NEEDS_TWO_BRANDS' })

    const drinks = await call(b.ownerToken, 'POST', '/rms/brands', {
      name: 'Drinks',
      colour: '#087f8c',
    })
    expect(drinks.statusCode).toBe(200)

    const on = await call(b.ownerToken, 'PUT', '/rms/settings', settings)
    expect(on.statusCode).toBe(200)
    const snapshot = await snapshotOf(b.ownerToken)
    expect(snapshot.settings.settlementEnabled).toBe(true)
    expect(snapshot.partners).toHaveLength(2)

    // The demo business's partners are untouched.
    expect(await prisma.partner.count({ where: { businessId: DEMO.businessId } })).toBe(2)
  })
})

describe('menu builder', () => {
  it('builds a menu with options the counter can sell', async () => {
    const b = await makeBusiness(app)
    const productId = await stockMenu(b, 450)

    const group = await call(b.ownerToken, 'POST', `/rms/products/${productId}/groups`, {
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
    })
    expect(group.statusCode).toBe(200)
    const groupId = (group.json() as { id: string }).id
    const large = await call(b.ownerToken, 'POST', `/rms/groups/${groupId}/options`, {
      name: 'Large',
      priceSen: 100,
    })
    expect(large.statusCode).toBe(200)
    const largeId = (large.json() as { id: string }).id

    const bShift = await openShift(app, b.counterToken, b.pin)
    const sale = await call(
      b.counterToken,
      'POST',
      '/checkout',
      checkoutPayload({
        shiftId: bShift,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 550,
        items: [{ product_id: productId, quantity: 1, modifiers: [{ modifier_id: largeId }] }],
      }),
    )
    expect(sale.statusCode, sale.body).toBe(200)

    // Sold, so it can be hidden but not deleted.
    const remove = await call(b.ownerToken, 'DELETE', `/rms/products/${productId}`)
    expect(remove.statusCode).toBe(409)
    expect(remove.json()).toMatchObject({ error: 'menu:IN_USE' })
    const hide = await call(b.ownerToken, 'PATCH', `/rms/products/${productId}`, {
      isActive: false,
    })
    expect(hide.statusCode).toBe(200)
  })

  it('refuses a group whose minimum is above its maximum, and a duplicate brand', async () => {
    const b = await makeBusiness(app, 'Dup Brand Co')
    const productId = await stockMenu(b)
    const group = await call(b.ownerToken, 'POST', `/rms/products/${productId}/groups`, {
      name: 'Bad',
      minSelect: 3,
      maxSelect: 1,
    })
    expect(group.statusCode).toBe(400)

    const duplicate = await call(b.ownerToken, 'POST', '/rms/brands', {
      name: 'Dup Brand Co',
      colour: '#000000',
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ error: 'menu:NAME_TAKEN' })

    // The same brand name is free in another business: names are per business.
    const other = await makeBusiness(app)
    const sameName = await call(other.ownerToken, 'POST', '/rms/brands', {
      name: 'Dup Brand Co',
      colour: '#000000',
    })
    expect(sameName.statusCode).toBe(200)
  })

  it('copies an option group onto another item as its own copy', async () => {
    const b = await makeBusiness(app)
    const first = await stockMenu(b, 500)
    const group = await call(b.ownerToken, 'POST', `/rms/products/${first}/groups`, {
      name: 'Size',
      minSelect: 1,
      maxSelect: 1,
    })
    const groupId = (group.json() as { id: string }).id
    for (const [name, priceSen] of [['Regular', 0], ['Large', 150]] as const) {
      await call(b.ownerToken, 'POST', `/rms/groups/${groupId}/options`, { name, priceSen })
    }

    // A second item, created with the first one's group copied on.
    const category = (await snapshotOf(b.ownerToken)).categories[0]
    const created = await call(b.ownerToken, 'POST', '/rms/products', {
      categoryId: category?.id,
      name: 'Teh Tarik',
      basePriceSen: 400,
      copyGroupIds: [groupId],
    })
    expect(created.statusCode, created.body).toBe(200)
    const second = (created.json() as { id: string }).id

    // A third, given it afterwards.
    const third = await stockMenu(b, 300)
    const copied = await call(b.ownerToken, 'POST', `/rms/products/${third}/groups/copy`, { groupId })
    expect(copied.statusCode).toBe(200)

    type Menu = Array<{
      id: string
      modifierGroups: Array<{ id: string; name: string; minSelect: number; options: Array<{ name: string; priceSen: number }> }>
    }>
    const products = (await snapshotOf(b.ownerToken)).products as unknown as Menu
    for (const id of [second, third]) {
      const [copy] = products.find((product) => product.id === id)?.modifierGroups ?? []
      expect(copy).toMatchObject({ name: 'Size', minSelect: 1 })
      expect(copy?.id).not.toBe(groupId)
      expect(copy?.options.map((option) => [option.name, option.priceSen])).toEqual([
        ['Regular', 0],
        ['Large', 150],
      ])
    }

    // Changing the original leaves the copies alone.
    await call(b.ownerToken, 'PATCH', `/rms/groups/${groupId}`, { name: 'Cup' })
    const after = (await snapshotOf(b.ownerToken)).products as unknown as Menu
    expect(after.find((product) => product.id === second)?.modifierGroups[0]?.name).toBe('Size')
  })

  it('will not copy another business’s option group', async () => {
    const b = await makeBusiness(app)
    const productId = await stockMenu(b)
    const demoGroup = await prisma.modifierGroup.findFirstOrThrow({
      where: { businessId: DEMO.businessId },
    })

    const copy = await call(b.ownerToken, 'POST', `/rms/products/${productId}/groups/copy`, {
      groupId: demoGroup.id,
    })
    expect(copy.statusCode).toBe(404)

    const category = (await snapshotOf(b.ownerToken)).categories[0]
    const create = await call(b.ownerToken, 'POST', '/rms/products', {
      categoryId: category?.id,
      name: 'Should not exist',
      basePriceSen: 100,
      copyGroupIds: [demoGroup.id],
    })
    expect(create.statusCode).toBe(404)
    // All or nothing: the item was not created without its groups.
    expect(await prisma.product.count({ where: { name: 'Should not exist' } })).toBe(0)
  })

  it('moves an item to another category, and with it to that category’s brand', async () => {
    const b = await makeBusiness(app)
    const productId = await stockMenu(b)
    const drinks = await call(b.ownerToken, 'POST', '/rms/brands', { name: 'Drinks', colour: '#087f8c' })
    const drinksId = (drinks.json() as { id: string }).id
    const cold = await call(b.ownerToken, 'POST', '/rms/categories', { brandId: drinksId, name: 'Cold' })
    const coldId = (cold.json() as { id: string }).id

    const move = await call(b.ownerToken, 'PATCH', `/rms/products/${productId}`, { categoryId: coldId })
    expect(move.statusCode).toBe(200)
    const moved = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(moved).toMatchObject({ categoryId: coldId, brandId: drinksId })
  })

  it('saves the order of categories, items, option groups and options, and the counter follows it', async () => {
    const b = await makeBusiness(app)
    const snap0 = await snapshotOf(b.ownerToken)
    const first = snap0.categories[0]!.id
    const second = (
      (await call(b.ownerToken, 'POST', '/rms/categories', { brandId: snap0.brands[0]!.id, name: 'Drinks' })).json() as { id: string }
    ).id
    const a = await stockMenu(b, 100)
    const c = await stockMenu(b, 300)
    const bId = (
      (await call(b.ownerToken, 'POST', '/rms/products', { categoryId: first, name: 'B', basePriceSen: 200 })).json() as { id: string }
    ).id

    // Categories: Drinks first.
    expect((await call(b.ownerToken, 'PUT', '/rms/categories/order', { ids: [second, first] })).statusCode).toBe(200)
    // Items: c, B, a in the first category.
    expect((await call(b.ownerToken, 'PUT', `/rms/categories/${first}/products`, { ids: [c, bId, a] })).statusCode).toBe(200)

    // Option groups and options.
    const g1 = ((await call(b.ownerToken, 'POST', `/rms/products/${c}/groups`, { name: 'G1', minSelect: 0, maxSelect: 1 })).json() as { id: string }).id
    const g2 = ((await call(b.ownerToken, 'POST', `/rms/products/${c}/groups`, { name: 'G2', minSelect: 0, maxSelect: 1 })).json() as { id: string }).id
    const o1 = ((await call(b.ownerToken, 'POST', `/rms/groups/${g1}/options`, { name: 'O1' })).json() as { id: string }).id
    const o2 = ((await call(b.ownerToken, 'POST', `/rms/groups/${g1}/options`, { name: 'O2' })).json() as { id: string }).id
    expect((await call(b.ownerToken, 'PUT', `/rms/products/${c}/groups/order`, { ids: [g2, g1] })).statusCode).toBe(200)
    expect((await call(b.ownerToken, 'PUT', `/rms/groups/${g1}/options/order`, { ids: [o2, o1] })).statusCode).toBe(200)

    type Boot = {
      categories: Array<{ id: string }>
      products: Array<{ id: string; modifier_groups: Array<{ id: string; options: Array<{ id: string }> }> }>
    }
    const boot = (await call(b.counterToken, 'GET', '/bootstrap')).json() as Boot
    expect(boot.categories.map((row) => row.id)).toEqual([second, first])
    expect(boot.products.map((row) => row.id)).toEqual([c, bId, a])
    const cItem = boot.products[0]!
    expect(cItem.modifier_groups.map((group) => group.id)).toEqual([g2, g1])
    expect(cItem.modifier_groups[1]!.options.map((option) => option.id)).toEqual([o2, o1])
  })

  it('moves an item by dropping it into another category’s list', async () => {
    const b = await makeBusiness(app)
    const item = await stockMenu(b)
    const drinks = ((await call(b.ownerToken, 'POST', '/rms/brands', { name: 'Drinks', colour: '#087f8c' })).json() as { id: string }).id
    const cold = ((await call(b.ownerToken, 'POST', '/rms/categories', { brandId: drinks, name: 'Cold' })).json() as { id: string }).id

    const drop = await call(b.ownerToken, 'PUT', `/rms/categories/${cold}/products`, { ids: [item] })
    expect(drop.statusCode).toBe(200)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: item } })).toMatchObject({
      categoryId: cold,
      brandId: drinks,
    })
  })

  it('refuses an order that leaves something out, repeats it, or reaches into another business', async () => {
    const b = await makeBusiness(app)
    const first = (await snapshotOf(b.ownerToken)).categories[0]!.id
    const one = await stockMenu(b)
    const two = await stockMenu(b)
    const demoProduct = await productByName('Ayam Goreng Berempah')
    const demoCategory = demoProduct.categoryId

    for (const ids of [[one], [one, one], [one, two, demoProduct.id]]) {
      const response = await call(b.ownerToken, 'PUT', `/rms/categories/${first}/products`, { ids })
      expect(response.statusCode, JSON.stringify(ids)).toBe(400)
      expect(response.json()).toMatchObject({ error: 'menu:ORDER_MISMATCH' })
    }
    // The demo product was not pulled into B's category.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: demoProduct.id } })).businessId).toBe(DEMO.businessId)

    expect((await call(b.ownerToken, 'PUT', `/rms/categories/${demoCategory}/products`, { ids: [one, two] })).statusCode).toBe(404)
    const all = await call(b.ownerToken, 'PUT', '/rms/categories/order', { ids: [first, demoCategory] })
    expect(all.statusCode).toBe(400)
  })

  it('will not delete the last brand', async () => {
    const b = await makeBusiness(app)
    const brand = (await snapshotOf(b.ownerToken)).brands[0]
    if (!brand) throw new Error('a new business should start with a brand')
    const response = await call(b.ownerToken, 'DELETE', `/rms/brands/${brand.id}`)
    expect(response.statusCode).toBe(409)
  })
})
