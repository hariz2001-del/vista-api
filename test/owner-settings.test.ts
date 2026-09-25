import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { businessDateToUtc, getBusinessDate } from '../src/domain/business-date.ts'
import { authed, DEMO, loginOwner, makeApp, makeBusiness, resetTransactional } from './helpers.ts'

/**
 * Promotions, which partner owns which brand, the trading-day rollover, and
 * making a new item's own option groups on the spot.
 */

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await resetTransactional()
  await prisma.promotion.deleteMany()
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetTransactional()
  await prisma.promotion.deleteMany()
})

function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
  return app.inject({ method, url, headers: authed(token), ...(payload ? { payload } : {}) })
}

function shiftDays(date: string, days: number): string {
  return new Date(businessDateToUtc(date).getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

describe('promotions', () => {
  it('creates, edits and deletes a promo, and refuses nonsense', async () => {
    const b = await makeBusiness(app)
    const today = getBusinessDate(new Date())
    const created = await call(b.ownerToken, 'POST', '/rms/promotions', {
      name: 'Merdeka 10%',
      kind: 'PERCENT',
      value: 10,
      startsOn: today,
      endsOn: shiftDays(today, 7),
    })
    expect(created.statusCode, created.body).toBe(200)
    const promo = created.json() as { id: string }

    const edited = await call(b.ownerToken, 'PUT', `/rms/promotions/${promo.id}`, {
      name: 'RM 2 off',
      kind: 'AMOUNT',
      value: 200,
      startsOn: today,
      endsOn: null,
      isActive: false,
    })
    expect(edited.json()).toMatchObject({ name: 'RM 2 off', kind: 'AMOUNT', value: 200, endsOn: null, isActive: false })

    for (const bad of [
      { name: 'Too much', kind: 'PERCENT', value: 150, startsOn: today, endsOn: null },
      { name: 'Backwards', kind: 'AMOUNT', value: 100, startsOn: today, endsOn: shiftDays(today, -1) },
      { name: 'Nothing', kind: 'AMOUNT', value: 0, startsOn: today, endsOn: null },
    ]) {
      expect((await call(b.ownerToken, 'POST', '/rms/promotions', bad)).statusCode, bad.name).toBe(400)
    }

    expect((await call(b.ownerToken, 'DELETE', `/rms/promotions/${promo.id}`)).statusCode).toBe(200)
    expect(await prisma.promotion.count({ where: { businessId: b.businessId } })).toBe(0)
  })

  it('gives the counter only switched-on promos that have not ended', async () => {
    const b = await makeBusiness(app)
    const today = getBusinessDate(new Date())
    const add = (name: string, extra: object) =>
      call(b.ownerToken, 'POST', '/rms/promotions', { name, kind: 'PERCENT', value: 10, startsOn: today, endsOn: null, ...extra })
    await add('Running', {})
    await add('Next week', { startsOn: shiftDays(today, 7) })
    await add('Paused', { isActive: false })
    await add('Over', { startsOn: shiftDays(today, -10), endsOn: shiftDays(today, -3) })
    await add('Ended yesterday', { startsOn: shiftDays(today, -5), endsOn: shiftDays(today, -1) })

    const boot = (await call(b.counterToken, 'GET', '/bootstrap')).json() as { promotions: Array<{ name: string }> }
    // Yesterday's is kept: a shift open past midnight still trades on yesterday's date.
    expect(boot.promotions.map((promo) => promo.name).toSorted()).toEqual(['Ended yesterday', 'Next week', 'Running'])
  })

  it('keeps promos to their own business', async () => {
    const a = await loginOwner(app)
    const b = await makeBusiness(app)
    const today = getBusinessDate(new Date())
    const created = await call(a, 'POST', '/rms/promotions', {
      name: 'Demo only', kind: 'PERCENT', value: 5, startsOn: today, endsOn: null,
    })
    const id = (created.json() as { id: string }).id

    const boot = (await call(b.counterToken, 'GET', '/bootstrap')).json() as { promotions: unknown[] }
    expect(boot.promotions).toEqual([])
    expect((await call(b.ownerToken, 'DELETE', `/rms/promotions/${id}`)).statusCode).toBe(404)
    expect(
      (await call(b.ownerToken, 'PUT', `/rms/promotions/${id}`, { name: 'x', kind: 'PERCENT', value: 5, startsOn: today, endsOn: null })).statusCode,
    ).toBe(404)
    expect(await prisma.promotion.count({ where: { id } })).toBe(1)
  })
})

describe('partners', () => {
  it('lets the owner say which partner owns which brand, keeping the roles with the brands', async () => {
    const owner = await loginOwner(app)
    const before = await prisma.partner.findMany({ where: { businessId: DEMO.businessId } })
    const food = before.find((partner) => partner.role === 'FOOD_OWNER')!
    const host = before.find((partner) => partner.role === 'STALL_HOST')!
    try {
      // Give the Food partner the Drinks brand.
      const moved = await call(owner, 'PUT', `/rms/partners/${food.id}`, { brandId: host.brandId })
      expect(moved.statusCode, moved.body).toBe(200)

      const after = await prisma.partner.findMany({ where: { businessId: DEMO.businessId } })
      expect(after.find((partner) => partner.brandId === host.brandId)).toMatchObject({ name: food.name, role: 'STALL_HOST' })
      expect(after.find((partner) => partner.brandId === food.brandId)).toMatchObject({ name: host.name, role: 'FOOD_OWNER' })
    } finally {
      await prisma.partner.update({ where: { id: food.id }, data: { name: food.name } })
      await prisma.partner.update({ where: { id: host.id }, data: { name: host.name } })
    }
  })
})

describe('trading day rollover', () => {
  it('saves the hour, gives it to the counter, and refuses one outside 0–12', async () => {
    const b = await makeBusiness(app, 'Late Night')
    const settings = {
      businessName: 'Late Night',
      outletName: 'Late Night',
      sharedOverheadFoodPct: 70,
      hostCommissionPct: 30,
      capitalAssetFoodPct: 50,
    }
    expect((await call(b.ownerToken, 'PUT', '/rms/settings', { ...settings, dayRolloverHour: 13 })).statusCode).toBe(400)
    expect((await call(b.ownerToken, 'PUT', '/rms/settings', { ...settings, dayRolloverHour: 3 })).statusCode).toBe(200)

    const boot = (await call(b.counterToken, 'GET', '/bootstrap')).json() as {
      account: { day_rollover_hour: number }
      business_date: string
    }
    expect(boot.account.day_rollover_hour).toBe(3)
    expect(boot.business_date).toBe(getBusinessDate(new Date(), 3))

    // Left out by a dashboard that does not know it, the hour stays as it was.
    await call(b.ownerToken, 'PUT', '/rms/settings', settings)
    expect((await prisma.accountSettings.findUniqueOrThrow({ where: { businessId: b.businessId } })).dayRolloverHour).toBe(3)
  })

  it('works out the date by the hour given', () => {
    // 02:30 Malaysia time on the 10th is 18:30 UTC on the 9th.
    const lateNight = new Date('2026-10-09T18:30:00Z')
    expect(getBusinessDate(lateNight, 5)).toBe('2026-10-09')
    expect(getBusinessDate(lateNight, 2)).toBe('2026-10-10')
    expect(getBusinessDate(lateNight, 0)).toBe('2026-10-10')
  })
})

describe('new items with their own option groups', () => {
  it('creates an item together with groups made up on the spot', async () => {
    const b = await makeBusiness(app)
    const category = (await prisma.category.findFirstOrThrow({ where: { businessId: b.businessId } })).id
    const created = await call(b.ownerToken, 'POST', '/rms/products', {
      categoryId: category,
      name: 'Roti Canai',
      basePriceSen: 200,
      newGroups: [
        { name: 'Style', minSelect: 1, maxSelect: 1, options: [{ name: 'Kosong' }, { name: 'Telur', priceSen: 100 }] },
        { name: 'Curry', minSelect: 0, maxSelect: 3, options: [{ name: 'Dhal' }, { name: 'Fish' }] },
      ],
    })
    expect(created.statusCode, created.body).toBe(200)

    const groups = await prisma.modifierGroup.findMany({
      where: { productId: (created.json() as { id: string }).id },
      orderBy: { sortOrder: 'asc' },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
    expect(groups.map((group) => [group.name, group.minSelect, group.maxSelect])).toEqual([
      ['Style', 1, 1],
      ['Curry', 0, 3],
    ])
    expect(groups[0]?.items.map((item) => [item.name, item.priceSen, item.type])).toEqual([
      ['Kosong', 0, 'REMOVAL'],
      ['Telur', 100, 'ADD_ON'],
    ])
  })

  it('refuses a group whose minimum is above its maximum, and creates nothing', async () => {
    const b = await makeBusiness(app)
    const category = (await prisma.category.findFirstOrThrow({ where: { businessId: b.businessId } })).id
    const response = await call(b.ownerToken, 'POST', '/rms/products', {
      categoryId: category,
      name: 'Broken',
      basePriceSen: 100,
      newGroups: [{ name: 'Bad', minSelect: 3, maxSelect: 1, options: [] }],
    })
    expect(response.statusCode).toBe(400)
    expect(await prisma.product.count({ where: { name: 'Broken' } })).toBe(0)
  })
})
