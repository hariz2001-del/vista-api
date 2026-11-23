import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setGoogleFetch } from '../src/campaigns/google.ts'
import { parseLocalDateTime, parseSheet } from '../src/campaigns/sheet-import.ts'
import { matchProduct } from '../src/campaigns/sync.ts'
import { prisma } from '../src/db.ts'
import { fakeGoogle, HEADERS, SHEET_COLUMNS, sheetCampaign, sheetRow, type FakeGoogle } from './campaign-fixture.ts'
import { authed, loginOwner, makeApp, makeBusiness, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let owner: string
let google: FakeGoogle
beforeAll(async () => {
  process.env.CAMPAIGN_SECRET_KEY = 'test-campaign-secret-key-that-is-long-enough-123'
  app = await makeApp()
  owner = await loginOwner(app)
})
beforeEach(async () => {
  await resetTransactional()
  google = fakeGoogle()
})
afterAll(async () => {
  setGoogleFetch(null)
  await app.close()
  await prisma.$disconnect()
})

const call = (method: 'GET' | 'POST', url: string, token = owner) => app.inject({ method, url, headers: authed(token) })
const sync = async (id: string) => {
  const response = await call('POST', `/rms/campaigns/${id}/sync`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

describe('sheet parsing', () => {
  it('groups rows into orders and reads links, money and local times', () => {
    const { orders } = parseSheet(
      [
        HEADERS,
        sheetRow({ code: 'BLOOM-A', total: 48, fileId: 'file-aaaaaaaaaa', coupon: 'SIB-AAAA-0001', item: '1 of 2' }),
        sheetRow({ code: 'BLOOM-A', total: 48, fileId: 'file-aaaaaaaaaa', coupon: 'SIB-AAAA-0002', item: '2 of 2', set: 'Golden Scholar (Sunflower set)' }),
        sheetRow({ code: 'BLOOM-B', coupon: 'SIB-BBBB-0001' }),
      ],
      { columns: SHEET_COLUMNS, totalPer: 'ORDER', fulfilmentColumns: ['Pickup date'] },
    )
    expect(orders).toHaveLength(2)
    const [a] = orders
    expect(a).toMatchObject({
      externalRef: 'BLOOM-A',
      customerName: 'Aina',
      contact: '012-345 6789',
      totalSen: 4800,
      proofUrl: 'https://drive.google.com/file/d/file-aaaaaaaaaa/view?usp=drivesdk',
      sourceStatus: 'Pending check',
      fulfilment: { 'Pickup date': 'Fri 20 Nov' },
    })
    expect(a!.lines.map((line) => [line.label, line.coupon])).toEqual([
      ['Crimson Charm (Rose set)', 'SIB-AAAA-0001'],
      ['Golden Scholar (Sunflower set)', 'SIB-AAAA-0002'],
    ])
    // 21:40 in Kuala Lumpur is 13:40 UTC.
    expect(a!.submittedAt?.toISOString()).toBe('2026-11-16T13:40:00.000Z')
  })

  it('reads the date formats a sheet tends to hold, and refuses impossible ones', () => {
    expect(parseLocalDateTime('2026-11-16 09:05')?.toISOString()).toBe('2026-11-16T01:05:00.000Z')
    expect(parseLocalDateTime('16 Nov 2026 2:05 PM')?.toISOString()).toBe('2026-11-16T06:05:00.000Z')
    expect(parseLocalDateTime('31/02/2026 10:00')).toBeNull()
    expect(parseLocalDateTime('next tuesday')).toBeNull()
  })

  it('matches a line to the most specific product name', () => {
    const products = [
      { id: 'a', externalKey: 'Berry', priceSen: 1 },
      { id: 'b', externalKey: 'Berry Smart', priceSen: 2 },
    ]
    expect(matchProduct('Berry Smart (Mix set)', products)?.id).toBe('b')
    expect(matchProduct('Berry (Mix)', products)?.id).toBe('a')
    expect(matchProduct('Berrylicious', products)).toBeNull()
  })
})

describe('campaign order sync', () => {
  it('imports orders, lines, coupons and proofs, and re-running changes nothing', async () => {
    const id = await sheetCampaign(app, owner)
    google.rows.push(
      sheetRow({ code: 'BLOOM-A1B2', total: 48, fileId: 'proof-file-0001', coupon: 'SIB-AAAA-0001', item: '1 of 2' }),
      sheetRow({ code: 'BLOOM-A1B2', total: 48, fileId: 'proof-file-0001', coupon: 'SIB-AAAA-0002', item: '2 of 2', set: 'Golden Scholar (Sunflower set)' }),
      sheetRow({ code: 'BLOOM-C3D4', name: 'Hafiz', coupon: 'SIB-CCCC-0001' }),
    )
    expect(await sync(id)).toMatchObject({ added: 2, updated: 0, unchanged: 0, skipped: 0 })

    const list = (await call('GET', `/rms/campaigns/${id}/orders?sort=externalRef&dir=asc`)).json()
    expect(list.total).toBe(2)
    const [first] = list.orders
    expect(first).toMatchObject({
      externalRef: 'BLOOM-A1B2',
      expectedSen: 4800,
      verification: 'UNVERIFIED',
      proof: { hasFile: true, readStatus: 'PENDING' },
    })
    expect(first.lines.map((line: { priceSen: number }) => line.priceSen)).toEqual([2400, 2400])
    expect(first.coupons.map((coupon: { code: string }) => coupon.code)).toEqual(['SIB-AAAA-0001', 'SIB-AAAA-0002'])
    expect(list.orders[1].proof).toMatchObject({ hasFile: false, readStatus: 'NONE' })

    // Again, unchanged: no duplicates.
    expect(await sync(id)).toMatchObject({ added: 0, updated: 0, unchanged: 2 })
    expect(await prisma.campaignOrder.count({ where: { campaignId: id } })).toBe(2)
    expect(await prisma.campaignCoupon.count({ where: { campaignId: id } })).toBe(3)

    // Never wrote to Google.
    expect(google.calls.filter((line) => !line.startsWith('GET') && !line.includes('oauth2'))).toEqual([])
  })

  it('picks up new submissions and changes without duplicating', async () => {
    const id = await sheetCampaign(app, owner)
    google.rows.push(sheetRow({ code: 'BLOOM-AAAA', coupon: 'SIB-AAAA-0001' }))
    await sync(id)
    google.rows.push(sheetRow({ code: 'BLOOM-BBBB', coupon: 'SIB-BBBB-0001' }))
    google.rows[1]![11] = 'Paid' // the sheet's own status column changed
    expect(await sync(id)).toMatchObject({ added: 1, updated: 1, unchanged: 0 })
    const order = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-AAAA' } })
    // The sheet's status is kept for reference; Vista's own decision is untouched.
    expect(order).toMatchObject({ sourceStatus: 'Paid', verification: 'UNVERIFIED' })
  })

  it('reports a coupon code that already belongs to another order instead of moving it', async () => {
    const id = await sheetCampaign(app, owner)
    google.rows.push(sheetRow({ code: 'BLOOM-AAAA', coupon: 'SIB-SAME-0001' }), sheetRow({ code: 'BLOOM-BBBB', coupon: 'SIB-SAME-0001' }))
    const result = await sync(id)
    expect(result.added).toBe(2)
    expect(result.notes.join(' ')).toContain('SIB-SAME-0001 already belongs to another order')
    expect(await prisma.campaignCoupon.count({ where: { code: 'SIB-SAME-0001' } })).toBe(1)
  })

  it('records a failed sync and says so', async () => {
    const id = await sheetCampaign(app, owner)
    google.failSheet = true
    const response = await call('POST', `/rms/campaigns/${id}/sync`)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('campaign:SYNC_FAILED')
    const summary = (await call('GET', `/rms/campaigns/${id}/summary`)).json()
    expect(summary.lastSync).toMatchObject({ status: 'FAILED', trigger: 'MANUAL' })
  })

  it('refuses to sync a campaign without a source', async () => {
    const created = await app.inject({ method: 'POST', url: '/rms/campaigns', headers: authed(owner), payload: { name: 'Empty' } })
    const response = await call('POST', `/rms/campaigns/${created.json().campaign.id}/sync`)
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('campaign:SOURCE_NOT_SET')
  })
})

describe('campaign orders table', () => {
  async function seeded() {
    const id = await sheetCampaign(app, owner)
    for (let n = 1; n <= 30; n++) {
      google.rows.push(sheetRow({ code: `BLOOM-${String(n).padStart(4, '0')}`, name: n === 7 ? 'Zulaikha' : `Customer ${n}`, coupon: `SIB-${String(n).padStart(4, '0')}-XXXX`, submitted: `${String((n % 28) + 1).padStart(2, '0')}/11/2026 10:00` }))
    }
    await sync(id)
    return id
  }

  it('pages, sorts and searches by name, order code or coupon', async () => {
    const id = await seeded()
    const page1 = (await call('GET', `/rms/campaigns/${id}/orders?pageSize=10&sort=externalRef&dir=asc`)).json()
    expect(page1.total).toBe(30)
    expect(page1.orders).toHaveLength(10)
    expect(page1.orders[0].externalRef).toBe('BLOOM-0001')
    const page3 = (await call('GET', `/rms/campaigns/${id}/orders?pageSize=10&page=3&sort=externalRef&dir=asc`)).json()
    expect(page3.orders[9].externalRef).toBe('BLOOM-0030')

    const byName = (await call('GET', `/rms/campaigns/${id}/orders?q=zulai`)).json()
    expect(byName.orders.map((order: { externalRef: string }) => order.externalRef)).toEqual(['BLOOM-0007'])
    const byCoupon = (await call('GET', `/rms/campaigns/${id}/orders?q=SIB-0012`)).json()
    expect(byCoupon.orders.map((order: { externalRef: string }) => order.externalRef)).toEqual(['BLOOM-0012'])

    const ids = (await call('GET', `/rms/campaigns/${id}/orders/ids?verification=UNVERIFIED`)).json()
    expect(ids.ids).toHaveLength(30)
  })

  it('summarises without counting unverified money as revenue', async () => {
    const id = await seeded()
    const summary = (await call('GET', `/rms/campaigns/${id}/summary`)).json()
    expect(summary).toMatchObject({
      orders: 30,
      expectedSen: 30 * 2400,
      verifiedSen: 0,
      unverified: 30,
      couponsIssued: 30,
      couponsRedeemed: 0,
      outstandingSen: 0,
    })
    expect(summary.lastSync).toMatchObject({ status: 'OK', added: 30 })
  })

  it('serves the payment proof privately and fingerprints it', async () => {
    const id = await sheetCampaign(app, owner)
    google.rows.push(sheetRow({ code: 'BLOOM-PRUF', fileId: 'proof-file-9999' }))
    google.files.set('proof-file-9999', { bytes: Buffer.from('fake-jpeg-bytes'), mimeType: 'image/jpeg' })
    await sync(id)
    const order = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-PRUF' } })
    const proof = await call('GET', `/rms/campaigns/${id}/orders/${order.id}/proof`)
    expect(proof.statusCode).toBe(200)
    expect(proof.headers['content-type']).toBe('image/jpeg')
    expect(proof.headers['cache-control']).toBe('private, no-store')
    expect(proof.body).toBe('fake-jpeg-bytes')
    const stored = await prisma.campaignPaymentProof.findFirstOrThrow({ where: { orderId: order.id } })
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/)

    const other = await makeBusiness(app)
    expect((await call('GET', `/rms/campaigns/${id}/orders/${order.id}/proof`, other.ownerToken)).statusCode).toBe(404)
    expect((await call('GET', `/rms/campaigns/${id}/orders/${order.id}`, other.ownerToken)).statusCode).toBe(404)
  })

  it('lets Hermes sync running campaigns that are due, and skips the rest', async () => {
    const business = await makeBusiness(app)
    const ownerHeaders = authed(business.ownerToken)
    const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: ownerHeaders, payload: { label: 'chopper' } })).json().key
    await app.inject({ method: 'POST', url: '/rms/agent/users', headers: ownerHeaders, payload: { telegramUserId: '222', role: 'BOOKKEEPER', name: 'bk' } })
    const id = await sheetCampaign(app, business.ownerToken)
    google.rows.push(sheetRow({ code: 'BLOOM-HERM', fileId: 'hermProof0001' }), sheetRow({ code: 'BLOOM-NOPF' }))
    const agent = { authorization: `Bearer ${key}`, 'x-telegram-user': '222' }
    const first = (await app.inject({ method: 'POST', url: '/agent/campaigns/sync', headers: agent })).json()
    expect(first.results).toEqual([expect.objectContaining({ campaignId: id, outcome: '+2 ~0 =0 !0' })])
    // One order came with a proof to read, so Hermes knows to ask for it; the other has nothing to read.
    expect(first.proofsWaiting).toBe(1)
    const second = (await app.inject({ method: 'POST', url: '/agent/campaigns/sync', headers: agent })).json()
    expect(second.results[0].outcome).toBe('not due')
    await prisma.campaignPaymentProof.updateMany({ where: { order: { externalRef: 'BLOOM-HERM' } }, data: { readStatus: 'DONE' } })
    expect((await app.inject({ method: 'POST', url: '/agent/campaigns/sync', headers: agent })).json().proofsWaiting).toBe(0)
  })
})

describe('pickups and collection', () => {
  async function seeded() {
    const id = await sheetCampaign(app, owner)
    google.rows.push(
      sheetRow({ code: 'BLOOM-P1', pickupDate: 'Tue 24 Nov', pickupSlot: 'Early Birds, 9AM to 1PM' }),
      sheetRow({ code: 'BLOOM-P2', pickupDate: 'Mon 23 Nov', pickupSlot: 'Early Birds, 1PM to 6PM' }),
      sheetRow({ code: 'BLOOM-P3', pickupDate: 'Mon 23 Nov', pickupSlot: 'Early Birds, 9AM to 1PM', status: 'Collected' }),
      sheetRow({ code: 'BLOOM-P4', pickupDate: 'Mon 23 Nov', pickupSlot: 'Early Birds, 9AM to 1PM' }),
    )
    await sync(id)
    return id
  }
  const refs = (body: { orders: { externalRef: string }[] }) => body.orders.map((order) => order.externalRef)

  it('lists pickup dates in date order with their slots', async () => {
    const id = await seeded()
    const pickups = (await call('GET', `/rms/campaigns/${id}/pickups`)).json()
    expect(pickups.hasPickup).toBe(true)
    expect(pickups.dates).toEqual([
      { value: 'Mon 23 Nov', isoDate: '2026-11-23', orders: 3, slots: [{ value: 'Early Birds, 1PM to 6PM', orders: 1 }, { value: 'Early Birds, 9AM to 1PM', orders: 2 }] },
      { value: 'Tue 24 Nov', isoDate: '2026-11-24', orders: 1, slots: [{ value: 'Early Birds, 9AM to 1PM', orders: 1 }] },
    ])
  })

  it('filters by pickup date and slot, sorts by pickup, and splits collected from not yet', async () => {
    const id = await seeded()
    const day = encodeURIComponent('Mon 23 Nov')
    const morning = encodeURIComponent('Early Birds, 9AM to 1PM')
    expect(refs((await call('GET', `/rms/campaigns/${id}/orders?pickupDate=${day}&sort=externalRef&dir=asc`)).json())).toEqual(['BLOOM-P2', 'BLOOM-P3', 'BLOOM-P4'])
    expect(refs((await call('GET', `/rms/campaigns/${id}/orders?pickupDate=${day}&pickupSlot=${morning}&sort=externalRef&dir=asc`)).json())).toEqual(['BLOOM-P3', 'BLOOM-P4'])
    const sorted = (await call('GET', `/rms/campaigns/${id}/orders?sort=pickup&dir=asc`)).json()
    expect(refs(sorted)).toEqual(['BLOOM-P2', 'BLOOM-P3', 'BLOOM-P4', 'BLOOM-P1'])
    expect(sorted.orders[0].pickup).toEqual({ date: 'Mon 23 Nov', isoDate: '2026-11-23', slot: 'Early Birds, 1PM to 6PM' })
    expect(refs((await call('GET', `/rms/campaigns/${id}/orders?collected=yes`)).json())).toEqual(['BLOOM-P3'])
    expect(refs((await call('GET', `/rms/campaigns/${id}/orders?collected=no&pickupDate=${day}&sort=externalRef&dir=asc`)).json())).toEqual(['BLOOM-P2', 'BLOOM-P4'])
  })
})
