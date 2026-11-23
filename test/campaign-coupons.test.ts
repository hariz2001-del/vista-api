import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setGoogleFetch } from '../src/campaigns/google.ts'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import { fakeGoogle, sheetCampaign, sheetRow, type FakeGoogle } from './campaign-fixture.ts'
import { authed, checkoutPayload, correctionPayload, DEMO, login, loginOwner, makeApp, openShift, productByName, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let owner: string
let counter: string
let google: FakeGoogle
let shiftId: string
let campaignId: string
let soda: Awaited<ReturnType<typeof productByName>>
let lime: Awaited<ReturnType<typeof productByName>>
let nasi: Awaited<ReturnType<typeof productByName>>
const today = () => getBusinessDate(new Date())

beforeAll(async () => {
  process.env.CAMPAIGN_SECRET_KEY = 'test-campaign-secret-key-that-is-long-enough-123'
  app = await makeApp()
  owner = await loginOwner(app)
  counter = await login(app)
  soda = await productByName('Soda Laici') // RM7, cold drinks
  lime = await productByName('Teh Limau Ais') // RM4.50, tea
  nasi = await productByName('Nasi Lemak Ayam') // RM12, food
})
beforeEach(async () => {
  await resetTransactional()
  google = fakeGoogle()
  shiftId = await openShift(app, counter)
})
afterAll(async () => {
  // Leave no extra till sessions behind for later files (rms-state counts them).
  await app.inject({ method: 'POST', url: '/rms/counter/sign-out', headers: authed(owner) })
  setGoogleFetch(null)
  await app.close()
  await prisma.$disconnect()
})

/** A campaign whose drink voucher covers every drink category, and two coupons. */
async function setup(options: { verify?: boolean; prepaidProductId?: string } = {}) {
  campaignId = await sheetCampaign(app, owner, {})
  const drinkCategories = [soda.categoryId, lime.categoryId]
  // Re-save the catalogue: flower prepaid (handed over, or a till item), and an RM5 voucher per drink category.
  const catalogue = await app.inject({
    method: 'PUT',
    url: `/rms/campaigns/${campaignId}/catalogue`,
    headers: authed(owner),
    payload: {
      products: [{ name: 'Crimson Charm', externalKey: 'Crimson Charm', priceSen: 2400 }],
      benefits: [
        { kind: 'PREPAID_PRODUCT', label: 'Flower bouquet', valueSen: 1900, productId: options.prepaidProductId ?? null },
        { kind: 'FIXED_VOUCHER', label: 'Drink voucher', valueSen: 500, categoryIds: drinkCategories },
      ],
    },
  })
  expect(catalogue.statusCode, catalogue.body).toBe(200)
  google.rows.push(sheetRow({ code: 'BLOOM-CPN1', coupon: 'SIB-AAAA-0001' }), sheetRow({ code: 'BLOOM-CPN2', coupon: 'SIB-BBBB-0002' }))
  await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/sync`, headers: authed(owner) })
  if (options.verify !== false) {
    for (const ref of ['BLOOM-CPN1', 'BLOOM-CPN2']) {
      const order = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: ref } })
      const verified = await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/orders/${order.id}/verify`, headers: authed(owner), payload: { paymentDate: today() } })
      expect(verified.statusCode, verified.body).toBe(200)
    }
  }
}

const lookup = (code: string) => app.inject({ method: 'GET', url: `/pos/coupons/${code}`, headers: authed(counter) })

async function benefitIds() {
  const benefits = await prisma.campaignBenefit.findMany({ where: { campaignId }, orderBy: { sortOrder: 'asc' } })
  return { flower: benefits[0]!.id, voucherFor: (categoryId: string) => benefits.find((b) => b.categoryIds.includes(categoryId))!.id }
}

/** A sale of the given lines, with coupons. */
function sale(input: {
  items: Array<{ product_id: string; quantity?: number; discount_sen?: number }>
  claimed: number
  coupons: Array<{ code: string; benefits: Array<{ benefit_id: string; line_index: number | null; amount_sen: number }> }>
  origin?: 'ONLINE' | 'OFFLINE_SYNC'
  txn?: string
}) {
  const payload = {
    ...checkoutPayload({
      shiftId,
      businessDate: today(),
      clientTxnId: input.txn ?? randomUUID(),
      claimedTotalSen: input.claimed,
      origin: input.origin,
      items: input.items.map((item) => ({ ...item, quantity: item.quantity ?? 1 })),
    }),
    coupon_redemptions: input.coupons,
  }
  return app.inject({ method: 'POST', url: '/checkout', headers: authed(counter), payload })
}

describe('coupon lookup at the till', () => {
  it('refuses a coupon whose payment is not verified', async () => {
    await setup({ verify: false })
    const response = await lookup('SIB-AAAA-0001')
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('coupon:NOT_PAID')
  })

  it('shows what a paid coupon gives: the prepaid flower and the drink voucher', async () => {
    await setup()
    const response = await lookup('sib-aaaa-0001') // typed in lower case
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.order).toMatchObject({ ref: 'BLOOM-CPN1', customerName: 'Aina' })
    expect(body.benefits.map((b: { kind: string; valueSen: number }) => [b.kind, b.valueSen])).toEqual([
      ['PREPAID_PRODUCT', 1900],
      ['FIXED_VOUCHER', 500],
    ])
    expect((await lookup('SIB-NOPE-0000')).statusCode).toBe(404)
  })

  it('refuses a rejected order and a paused campaign', async () => {
    await setup({ verify: false })
    const order = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-CPN1' } })
    await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/orders/${order.id}/reject`, headers: authed(owner), payload: {} })
    expect((await lookup('SIB-AAAA-0001')).json().error).toBe('coupon:REJECTED')
    const other = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-CPN2' } })
    await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/orders/${other.id}/verify`, headers: authed(owner), payload: { paymentDate: today() } })
    await app.inject({ method: 'PATCH', url: `/rms/campaigns/${campaignId}`, headers: authed(owner), payload: { status: 'INACTIVE' } })
    expect((await lookup('SIB-BBBB-0002')).json().error).toBe('coupon:CAMPAIGN_CLOSED')
  })
})

describe('finding a coupon the customer did not keep', () => {
  const find = (query: string) => app.inject({ method: 'GET', url: `/pos/campaigns/${campaignId}/coupons?${query}`, headers: authed(counter) })

  it('lists the running campaigns with the part every code starts with', async () => {
    await setup()
    const response = await app.inject({ method: 'GET', url: '/pos/campaigns', headers: authed(counter) })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().campaigns).toEqual([{ id: campaignId, name: expect.any(String), codePrefix: 'SIB-' }])
  })

  it('finds every coupon on a phone number, however it is written, and says which cannot be used', async () => {
    await setup()
    google.rows.push(sheetRow({ code: 'BLOOM-CPN3', coupon: 'SIB-CCCC-0003', name: 'Danish', phone: '+60 19-888 1234' }))
    await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/sync`, headers: authed(owner) })

    const aina = await find(`phone=${encodeURIComponent('60123456789')}`)
    expect(aina.statusCode, aina.body).toBe(200)
    expect(aina.json().coupons.map((c: { code: string; problem: string | null }) => [c.code, c.problem])).toEqual([
      ['SIB-AAAA-0001', null],
      ['SIB-BBBB-0002', null],
    ])
    const danish = await find(`phone=${encodeURIComponent('019 888 1234')}`)
    expect(danish.json().coupons).toEqual([
      { code: 'SIB-CCCC-0003', customerName: 'Danish', phone: '+60 19-888 1234', orderRef: 'BLOOM-CPN3', item: 'Crimson Charm (Rose set)', problem: 'coupon:NOT_PAID' },
    ])
    // Only the whole number: part of one finds nobody, and too short is refused.
    expect((await find('phone=0123456')).json().error).toBe('coupon:PHONE_TOO_SHORT')
    expect((await find('phone=0123456780')).json().coupons).toEqual([])
  })

  it('finds a coupon by the code after its prefix, with or without dashes', async () => {
    await setup()
    for (const typed of ['BBBB-0002', 'bbbb0002', 'SIB-BBBB-0002']) {
      const response = await find(`code=${encodeURIComponent(typed)}`)
      expect(response.json().coupons.map((c: { code: string }) => c.code), typed).toEqual(['SIB-BBBB-0002'])
    }
    expect((await find('code=BBBB')).json().coupons).toEqual([])
    expect((await find('code=AAAA-0001&phone=0123456789')).json().error).toBe('coupon:SEARCH_ONE')
  })

  it('shows the phone number on the coupon, and its design preview when there is one', async () => {
    await setup()
    const body = (await lookup('SIB-AAAA-0001')).json()
    expect(body.order).toMatchObject({ phone: '012-345 6789', item: 'Crimson Charm (Rose set)', hasDesign: false })
    expect((await app.inject({ method: 'GET', url: '/pos/coupons/SIB-AAAA-0001/design', headers: authed(counter) })).json().error).toBe('campaign:DESIGN_NOT_FOUND')
  })
})

describe('redeeming at checkout', () => {
  it('charges only RM2 for an RM7 drink with the RM5 voucher, and hands over the prepaid flower', async () => {
    await setup()
    const ids = await benefitIds()
    const response = await sale({
      items: [{ product_id: soda.id, discount_sen: 500 }],
      claimed: 200,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.flower, line_index: null, amount_sen: 0 }, { benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }],
    })
    expect(response.statusCode, response.body).toBe(200)
    const order = await prisma.order.findFirstOrThrow({ where: { clientTxnId: response.json().client_txn_id ?? undefined }, include: { items: true } }).catch(() => null)
    const posOrder = order ?? (await prisma.order.findFirstOrThrow({ orderBy: { createdAt: 'desc' }, include: { items: true } }))
    expect(posOrder.totalAmountSen).toBe(200)
    expect(posOrder.items[0]).toMatchObject({ unitPriceSen: 700, lineDiscountSen: 500 }) // the drink is still recorded at its value
    const redemption = await prisma.campaignRedemption.findFirstOrThrow({ where: { posOrderId: posOrder.id } })
    expect(redemption).toMatchObject({ status: 'COMPLETED', prepaidSen: 1900, voucherSen: 500 })
    // Only the RM2 actually taken is revenue today; the RM24 was booked when the payment was verified.
    const sales = await prisma.ledgerEntry.findMany({ where: { businessId: DEMO.businessId, orderId: posOrder.id } })
    expect(sales.reduce((sum, entry) => sum + entry.amountSen, 0)).toBe(200)
  })

  it('makes a cheaper drink free but never negative', async () => {
    await setup()
    const ids = await benefitIds()
    const over = await sale({
      items: [{ product_id: lime.id, discount_sen: 450 }],
      claimed: 0,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(lime.categoryId), line_index: 0, amount_sen: 500 }] }],
    })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toBe('coupon:MISMATCH')
    const ok = await sale({
      items: [{ product_id: lime.id, discount_sen: 450 }],
      claimed: 0,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(lime.categoryId), line_index: 0, amount_sen: 450 }] }],
    })
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('gives one RM5 voucher per coupon, even with two eligible drinks', async () => {
    await setup()
    const ids = await benefitIds()
    const voucher = ids.voucherFor(soda.categoryId)
    expect(voucher).toBe(ids.voucherFor(lime.categoryId)) // one voucher covers every drink category
    const twice = await sale({
      items: [{ product_id: soda.id, discount_sen: 500 }, { product_id: lime.id, discount_sen: 450 }],
      claimed: 200,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: voucher, line_index: 0, amount_sen: 500 }, { benefit_id: voucher, line_index: 1, amount_sen: 450 }] }],
    })
    expect(twice.json().error).toBe('coupon:MISMATCH')
    expect(await prisma.order.count({ where: { businessId: DEMO.businessId } })).toBe(0)
  })

  it('rings a prepaid till item at its price, fully discounted', async () => {
    await setup({ prepaidProductId: nasi.id })
    const ids = await benefitIds()
    const response = await sale({
      items: [{ product_id: nasi.id, discount_sen: 1200 }],
      claimed: 0,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.flower, line_index: 0, amount_sen: 1200 }] }],
    })
    expect(response.statusCode, response.body).toBe(200)
    const posOrder = await prisma.order.findFirstOrThrow({ orderBy: { createdAt: 'desc' }, include: { items: true } })
    expect(posOrder.items[0]).toMatchObject({ productName: 'Nasi Lemak Ayam', unitPriceSen: 1200, lineDiscountSen: 1200 })
    expect(posOrder.totalAmountSen).toBe(0)
  })

  it('cannot use the same coupon twice, and the second sale is not recorded', async () => {
    await setup()
    const ids = await benefitIds()
    const use = () =>
      sale({
        items: [{ product_id: soda.id, discount_sen: 500 }],
        claimed: 200,
        coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }],
      })
    const [a, b] = await Promise.all([use(), use()])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect([a, b].find((r) => r.statusCode === 409)!.json().error).toBe('coupon:USED')
    expect(await prisma.order.count({ where: { businessId: DEMO.businessId } })).toBe(1)
    expect((await lookup('SIB-AAAA-0001')).json().error).toBe('coupon:USED')
  })

  it('does not use up the coupon when the sale fails, or after the sale is cancelled', async () => {
    await setup()
    const ids = await benefitIds()
    const coupons = [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }]
    const failed = await sale({ items: [{ product_id: soda.id, discount_sen: 500 }], claimed: 999, coupons })
    expect(failed.statusCode).toBe(400) // the total did not match
    expect((await lookup('SIB-AAAA-0001')).statusCode).toBe(200)

    const txn = randomUUID()
    expect((await sale({ items: [{ product_id: soda.id, discount_sen: 500 }], claimed: 200, coupons, txn })).statusCode).toBe(200)
    expect((await lookup('SIB-AAAA-0001')).json().error).toBe('coupon:USED')
    const cancel = await app.inject({
      method: 'POST',
      url: '/corrections',
      headers: authed(counter),
      payload: correctionPayload({ clientTxnId: randomUUID(), originalClientTxnId: txn, kind: 'CANCEL', claimedDeltaSen: -200 }),
    })
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect((await lookup('SIB-AAAA-0001')).statusCode).toBe(200)
    expect(await prisma.campaignRedemption.findFirstOrThrow()).toMatchObject({ status: 'REVERSED' })
  })

  it('refuses coupon amounts that are not on the bill, or on the wrong item', async () => {
    await setup()
    const ids = await benefitIds()
    const notOnBill = await sale({
      items: [{ product_id: soda.id }],
      claimed: 700,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }],
    })
    expect(notOnBill.json().error).toBe('coupon:MISMATCH')
    const food = await sale({
      items: [{ product_id: nasi.id, discount_sen: 500 }],
      claimed: 700,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }],
    })
    expect(food.json().error).toBe('coupon:MISMATCH')
    expect(await prisma.order.count({ where: { businessId: DEMO.businessId } })).toBe(0)
  })

  it('takes an offline sale even if its coupon was used meanwhile, and flags it', async () => {
    await setup()
    const ids = await benefitIds()
    const coupons = [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }]
    expect((await sale({ items: [{ product_id: soda.id, discount_sen: 500 }], claimed: 200, coupons })).statusCode).toBe(200)
    const offline = await sale({ items: [{ product_id: soda.id, discount_sen: 500 }], claimed: 200, coupons, origin: 'OFFLINE_SYNC' })
    expect(offline.statusCode, offline.body).toBe(200)
    const flagged = await prisma.order.findFirstOrThrow({ where: { origin: 'OFFLINE_SYNC' } })
    expect(flagged.needsReview).toBe(true)
    expect(flagged.reviewReason).toContain('Coupon not redeemed')
    expect(await prisma.campaignRedemption.count({ where: { status: 'COMPLETED' } })).toBe(1)
  })

  it('blocks undoing a payment once its coupon is used, and counts redemptions', async () => {
    await setup()
    const ids = await benefitIds()
    await sale({
      items: [{ product_id: soda.id, discount_sen: 500 }],
      claimed: 200,
      coupons: [{ code: 'SIB-AAAA-0001', benefits: [{ benefit_id: ids.flower, line_index: null, amount_sen: 0 }, { benefit_id: ids.voucherFor(soda.categoryId), line_index: 0, amount_sen: 500 }] }],
    })
    const order = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-CPN1' } })
    const undo = await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/orders/${order.id}/unverify`, headers: authed(owner), payload: { note: 'oops' } })
    expect(undo.json().error).toBe('campaign:ORDER_REDEEMED')
    const summary = (await app.inject({ method: 'GET', url: `/rms/campaigns/${campaignId}/summary`, headers: authed(owner) })).json()
    expect(summary).toMatchObject({ couponsIssued: 2, couponsRedeemed: 1 })
    // Only the unused coupon is still owed: its flower and its one RM5 voucher.
    expect(summary.outstandingSen).toBe(1900 + 500)
  })
})

describe('walk-in sales on the campaign dashboard', () => {
  it('counts the walk-in items sold over the counter, but not cancelled sales', async () => {
    await setup()
    const linked = await app.inject({ method: 'PATCH', url: `/rms/campaigns/${campaignId}`, headers: authed(owner), payload: { walkInProductIds: [soda.id] } })
    expect(linked.statusCode, linked.body).toBe(200)
    expect(linked.json().campaign.walkInProductIds).toEqual([soda.id])

    expect((await sale({ items: [{ product_id: soda.id, quantity: 2 }, { product_id: nasi.id }], claimed: 2600, coupons: [] })).statusCode).toBe(200)
    const kept = await sale({ items: [{ product_id: soda.id }], claimed: 700, coupons: [] })
    expect(kept.statusCode, kept.body).toBe(200)
    const txn = randomUUID()
    expect((await sale({ items: [{ product_id: soda.id }], claimed: 700, coupons: [], txn })).statusCode).toBe(200)
    const cancel = await app.inject({
      method: 'POST',
      url: '/corrections',
      headers: authed(counter),
      payload: correctionPayload({ clientTxnId: randomUUID(), originalClientTxnId: txn, kind: 'CANCEL', claimedDeltaSen: -700 }),
    })
    expect(cancel.statusCode, cancel.body).toBe(200)

    const summary = (await app.inject({ method: 'GET', url: `/rms/campaigns/${campaignId}/summary`, headers: authed(owner) })).json()
    expect(summary.walkIns).toEqual({ sales: 2, units: 3, netSen: 2100, items: [{ productId: soda.id, name: 'Soda Laici', units: 3, netSen: 2100 }] })
  })
})
