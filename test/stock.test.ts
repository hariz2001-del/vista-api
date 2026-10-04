import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { authed, makeApp, makeBusiness, type TestBusiness } from './helpers.ts'

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

function call(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: authed(token), payload: payload as object })
}

async function ok<T>(token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const response = await call(token, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as T
}

type Item = { id: string; name: string; category: string; subcategory: string | null }
type Sheet = {
  businessDate: string
  branchName: string
  items: Item[]
  staff: Array<{ id: string; name: string; rostered: boolean }>
}
type Count = {
  businessDate: string
  branchName: string
  staffName: string
  remarks: string | null
  lines: Array<{
    name: string
    category: string
    unitLabel: string | null
    unopenedMilli: number | null
    openedMilli: number | null
    balance: string | null
  }>
}

async function setUp(): Promise<{ b: TestBusiness; brandId: string }> {
  const b = await makeBusiness(app)
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: b.businessId } })
  return { b, brandId: brand.id }
}

function item(brandId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    brandId,
    category: 'Drinks',
    subcategory: 'Milk',
    name,
    unitLabel: 'bottles',
    trackUnopened: true,
    trackOpened: false,
    trackBalance: true,
    ...extra,
  }
}

describe('stock — the list the owner sets up', () => {
  it('keeps items in the order the owner arranges, and refuses an item that tracks nothing', async () => {
    const { b, brandId } = await setUp()
    const milk = await ok<{ item: Item }>(b.ownerToken, 'POST', '/rms/stock/items', item(brandId, 'Fresh Milk'))
    const oat = await ok<{ item: Item }>(b.ownerToken, 'POST', '/rms/stock/items', item(brandId, 'Oat Milk'))

    await ok(b.ownerToken, 'PUT', '/rms/stock/items/order', { ids: [oat.item.id, milk.item.id] })
    const list = await ok<{ items: Item[] }>(b.ownerToken, 'GET', '/rms/stock/items')
    expect(list.items.map((entry) => entry.name)).toEqual(['Oat Milk', 'Fresh Milk'])

    const nothing = await call(b.ownerToken, 'POST', '/rms/stock/items', {
      ...item(brandId, 'Ghost'),
      trackUnopened: false,
      trackBalance: false,
    })
    expect(nothing.statusCode).toBe(400)

    // A partial order would silently drop items: refused.
    const partial = await call(b.ownerToken, 'PUT', '/rms/stock/items/order', { ids: [oat.item.id] })
    expect(partial.statusCode).toBe(409)
  })

  it('is the owner’s alone: the counter can read the sheet but not change the list', async () => {
    const { b, brandId } = await setUp()
    const refused = await call(b.counterToken, 'POST', '/rms/stock/items', item(brandId, 'Fresh Milk'))
    expect(refused.statusCode).toBe(403)
  })

  it('keeps each business’s list to itself', async () => {
    const first = await setUp()
    const second = await setUp()
    const theirs = await ok<{ item: Item }>(first.b.ownerToken, 'POST', '/rms/stock/items', item(first.brandId, 'Theirs'))

    const sheet = await ok<Sheet>(second.b.counterToken, 'GET', '/stock/sheet')
    expect(sheet.items).toHaveLength(0)
    const steal = await call(second.b.ownerToken, 'DELETE', `/rms/stock/items/${theirs.item.id}`)
    expect(steal.statusCode).toBe(404)
  })

  it('will not delete a brand that still has stock items', async () => {
    const { b, brandId } = await setUp()
    await ok(b.ownerToken, 'POST', '/rms/brands', { name: 'Second', colour: '#123456' })
    await ok(b.ownerToken, 'POST', '/rms/stock/items', item(brandId, 'Fresh Milk'))
    const refused = await call(b.ownerToken, 'DELETE', `/rms/brands/${brandId}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ error: 'menu:BRAND_HAS_STOCK' })
  })
})

describe('stock — counting at the counter and reading it back', () => {
  it('snapshots the list as it stood, so later edits leave the old count as it read', async () => {
    const { b, brandId } = await setUp()
    const milk = await ok<{ item: Item }>(b.ownerToken, 'POST', '/rms/stock/items', item(brandId, 'Fresh Milk'))
    const cups = await ok<{ item: Item }>(
      b.ownerToken,
      'POST',
      '/rms/stock/items',
      item(brandId, 'Cups', { category: 'Packaging', subcategory: null, unitLabel: 'packs', trackBalance: false }),
    )
    const hidden = await ok<{ item: Item }>(
      b.ownerToken,
      'POST',
      '/rms/stock/items',
      item(brandId, 'Retired', { isActive: false }),
    )

    const sheet = await ok<Sheet>(b.counterToken, 'GET', '/stock/sheet')
    expect(sheet.items.map((entry) => entry.name)).toEqual(['Fresh Milk', 'Cups'])

    const submitted = await ok<{ id: string }>(b.counterToken, 'POST', '/stock/counts', {
      staffName: 'Aina',
      remarks: 'Order more oat milk',
      lines: [
        { stockItemId: milk.item.id, unopenedMilli: 3000, balance: 'HALF' },
        // A balance for an item that does not track one is dropped, and an
        // inactive item's figures are ignored.
        { stockItemId: cups.item.id, unopenedMilli: 2500, balance: 'LESS_THAN_HALF' },
        { stockItemId: hidden.item.id, unopenedMilli: 9000 },
      ],
    })

    // The owner renames and regroups the item afterwards.
    await ok(b.ownerToken, 'PUT', `/rms/stock/items/${milk.item.id}`, item(brandId, 'Full Cream Milk', { category: 'Dairy' }))
    await ok(b.ownerToken, 'DELETE', `/rms/stock/items/${cups.item.id}`)

    const { count } = await ok<{ count: Count }>(b.ownerToken, 'GET', `/rms/stock/counts/${submitted.id}`)
    expect(count).toMatchObject({ staffName: 'Aina', remarks: 'Order more oat milk', businessDate: sheet.businessDate })
    expect(count.lines).toEqual([
      expect.objectContaining({ name: 'Fresh Milk', category: 'Drinks', unopenedMilli: 3000, balance: 'HALF' }),
      expect.objectContaining({ name: 'Cups', unitLabel: 'packs', unopenedMilli: 2500, balance: null }),
    ])
  })

  it('needs to know who counted, and takes the name from the roster when a staff member is picked', async () => {
    const { b } = await setUp()
    const nobody = await call(b.counterToken, 'POST', '/stock/counts', { lines: [] })
    expect(nobody.statusCode).toBe(400)
    expect(nobody.json()).toMatchObject({ error: 'stock:WHO_COUNTED' })

    const { staff } = await ok<{ staff: { id: string } }>(b.ownerToken, 'POST', '/rms/team/staff', { name: 'Hakim' })
    const sheet = await ok<Sheet>(b.counterToken, 'GET', '/stock/sheet')
    expect(sheet.staff).toEqual([expect.objectContaining({ id: staff.id, name: 'Hakim', rostered: false })])

    await ok(b.counterToken, 'POST', '/stock/counts', { staffId: staff.id, staffName: 'Someone else', lines: [] })
    const { counts } = await ok<{ counts: Array<{ staffName: string; branchName: string }> }>(
      b.ownerToken,
      'GET',
      '/rms/stock/counts',
    )
    expect(counts).toEqual([expect.objectContaining({ staffName: 'Hakim', branchName: sheet.branchName })])
  })

  it('filters past counts by date and by who counted', async () => {
    const { b } = await setUp()
    await ok(b.counterToken, 'POST', '/stock/counts', { staffName: 'Aina', lines: [] })
    await ok(b.counterToken, 'POST', '/stock/counts', { staffName: 'Hakim', lines: [] })
    const sheet = await ok<Sheet>(b.counterToken, 'GET', '/stock/sheet')

    const byStaff = await ok<{ counts: unknown[] }>(b.ownerToken, 'GET', '/rms/stock/counts?staff=Aina')
    expect(byStaff.counts).toHaveLength(1)
    const today = await ok<{ counts: unknown[] }>(
      b.ownerToken,
      'GET',
      `/rms/stock/counts?from=${sheet.businessDate}&to=${sheet.businessDate}`,
    )
    expect(today.counts).toHaveLength(2)
    const before = await ok<{ counts: unknown[] }>(b.ownerToken, 'GET', '/rms/stock/counts?to=2000-01-01')
    expect(before.counts).toHaveLength(0)

    // Owner-only: the counter cannot read the history back.
    const counterRead = await call(b.counterToken, 'GET', '/rms/stock/counts')
    expect(counterRead.statusCode).toBe(403)
  })
})
