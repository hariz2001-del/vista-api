import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setGoogleFetch } from '../src/campaigns/google.ts'
import { desiredStatus } from '../src/campaigns/writeback.ts'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import { fakeGoogle, sheetCampaign, sheetRow, WRITE_BACK, type FakeGoogle } from './campaign-fixture.ts'
import { authed, checkoutPayload, correctionPayload, login, loginOwner, makeApp, openShift, productByName, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let owner: string
let counter: string
let google: FakeGoogle
let campaignId: string
const today = () => getBusinessDate(new Date())
const STATUS = 11 // column L
const REDEEMED = 15 // column P

beforeAll(async () => {
  process.env.CAMPAIGN_SECRET_KEY = 'test-campaign-secret-key-that-is-long-enough-123'
  app = await makeApp()
  owner = await loginOwner(app)
  counter = await login(app)
})
beforeEach(async () => {
  await resetTransactional()
  google = fakeGoogle()
  campaignId = await sheetCampaign(app, owner, { writeBack: true })
  google.rows.push(
    sheetRow({ code: 'BLOOM-TWO1', coupon: 'SIB-TWO1-0001', item: '1 of 2' }),
    sheetRow({ code: 'BLOOM-ONE1', coupon: 'SIB-ONE1-0001' }),
    sheetRow({ code: 'BLOOM-TWO1', coupon: 'SIB-TWO1-0002', item: '2 of 2' }), // sorted apart on purpose
  )
  await post(`/rms/campaigns/${campaignId}/sync`)
})
afterAll(async () => {
  await app.inject({ method: 'POST', url: '/rms/counter/sign-out', headers: authed(owner) })
  setGoogleFetch(null)
  await app.close()
  await prisma.$disconnect()
})

const post = (url: string, payload: object = {}, token = owner) => app.inject({ method: 'POST', url, headers: authed(token), payload })
const orderId = async (ref: string) => (await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: ref } })).id
const statusOf = (ref: string) => google.rows.filter((row) => row[0] === ref).map((row) => row[STATUS])

describe('status cell rules', () => {
  it('leaves statuses the owner moved on, and only takes back what Vista wrote', () => {
    expect(desiredStatus('VERIFIED', 'Pending check', WRITE_BACK)).toBe('Paid')
    expect(desiredStatus('VERIFIED', 'Collected', WRITE_BACK)).toBeNull()
    expect(desiredStatus('REJECTED', 'Pending check', WRITE_BACK)).toBe('Rejected')
    expect(desiredStatus('UNVERIFIED', 'Paid', WRITE_BACK)).toBe('Pending check')
    expect(desiredStatus('UNVERIFIED', 'Pending check', WRITE_BACK)).toBeNull()
  })
})

describe('Vista decisions reach the sheet', () => {
  it('marks every row of a verified order Paid, wherever the rows sit', async () => {
    const response = await post(`/rms/campaigns/${campaignId}/orders/${await orderId('BLOOM-TWO1')}/verify`, { paymentDate: today() })
    expect(response.statusCode, response.body).toBe(200)
    expect(statusOf('BLOOM-TWO1')).toEqual(['Paid', 'Paid'])
    expect(statusOf('BLOOM-ONE1')).toEqual(['Pending check'])
    expect(google.writes.map((write) => write.range).sort()).toEqual(['Preorders!L2', 'Preorders!L4'])
    expect((await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-TWO1' } })).sheetDirty).toBe(false)
  })

  it('writes Rejected, and puts it back to Pending check when reopened', async () => {
    const id = await orderId('BLOOM-ONE1')
    await post(`/rms/campaigns/${campaignId}/orders/${id}/reject`, { note: 'no transfer' })
    expect(statusOf('BLOOM-ONE1')).toEqual(['Rejected'])
    await post(`/rms/campaigns/${campaignId}/orders/${id}/reopen`)
    expect(statusOf('BLOOM-ONE1')).toEqual(['Pending check'])
  })

  it('does not overwrite a status the owner moved on to', async () => {
    google.rows[2]![STATUS] = 'Collected'
    await post(`/rms/campaigns/${campaignId}/orders/${await orderId('BLOOM-ONE1')}/verify`, { paymentDate: today() })
    expect(statusOf('BLOOM-ONE1')).toEqual(['Collected'])
    expect(google.writes).toEqual([])
  })

  it('never writes anything else: no rows, no other columns', async () => {
    await post(`/rms/campaigns/${campaignId}/orders/${await orderId('BLOOM-TWO1')}/verify`, { paymentDate: today() })
    await post(`/rms/campaigns/${campaignId}/orders/${await orderId('BLOOM-ONE1')}/reject`)
    expect(google.rows).toHaveLength(4)
    expect(google.writes.every((write) => /^Preorders!(L|P)\d+$/.test(write.range))).toBe(true)
  })

  it('keeps the change waiting when Google fails, and sends it on the next sync', async () => {
    google.failWrites = true
    const response = await post(`/rms/campaigns/${campaignId}/orders/${await orderId('BLOOM-ONE1')}/verify`, { paymentDate: today() })
    expect(response.statusCode).toBe(200) // the decision itself still stands
    const waiting = await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-ONE1' } })
    expect(waiting).toMatchObject({ verification: 'VERIFIED', sheetDirty: true })
    expect(waiting.sheetPushError).toContain('429')
    expect(statusOf('BLOOM-ONE1')).toEqual(['Pending check'])

    google.failWrites = false
    const synced = (await post(`/rms/campaigns/${campaignId}/sync`)).json()
    expect(synced.notes).toEqual([])
    expect(statusOf('BLOOM-ONE1')).toEqual(['Paid'])
    expect(await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-ONE1' } })).toMatchObject({ sheetDirty: false, sheetPushError: null })
    // The sync read the sheet after writing, so Vista's copy of the status agrees.
    expect((await prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: 'BLOOM-ONE1' } })).sourceStatus).toBe('Paid')
  })

  it('ticks Voucher redeemed for the coupon used at the till, and unticks it when the sale is cancelled', async () => {
    await post(`/rms/campaigns/${campaignId}/orders/${await orderId('BLOOM-TWO1')}/verify`, { paymentDate: today() })
    const soda = await productByName('Soda Laici')
    const voucher = (await prisma.campaignBenefit.findFirstOrThrow({ where: { campaignId, kind: 'FIXED_VOUCHER' } })).id
    const shiftId = await openShift(app, counter)
    const txn = randomUUID()
    const sale = await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: authed(counter),
      payload: {
        ...checkoutPayload({ shiftId, businessDate: today(), clientTxnId: txn, claimedTotalSen: 200, items: [{ product_id: soda.id, quantity: 1, discount_sen: 500 }] }),
        coupon_redemptions: [{ code: 'SIB-TWO1-0002', benefits: [{ benefit_id: voucher, line_index: 0, amount_sen: 500 }] }],
      },
    })
    expect(sale.statusCode, sale.body).toBe(200)
    // The till never waits on Google: the tick goes out with the next sync.
    expect(google.rows[3]![REDEEMED]).toBe(false)
    await post(`/rms/campaigns/${campaignId}/sync`)
    expect(google.rows.map((row) => row[REDEEMED])).toEqual(['Voucher redeemed', false, false, true])

    await app.inject({
      method: 'POST',
      url: '/corrections',
      headers: authed(counter),
      payload: correctionPayload({ clientTxnId: randomUUID(), originalClientTxnId: txn, kind: 'CANCEL', claimedDeltaSen: -200 }),
    })
    await post(`/rms/campaigns/${campaignId}/sync`)
    expect(google.rows[3]![REDEEMED]).toBe(false)
  })

  it('warns, and tells the till why, when the sheet was marked Paid by hand but Vista has not verified it', async () => {
    google.rows[2]![STATUS] = 'Paid' // BLOOM-ONE1, set in the sheet directly
    await post(`/rms/campaigns/${campaignId}/sync`)
    const id = await orderId('BLOOM-ONE1')
    const detail = (await app.inject({ method: 'GET', url: `/rms/campaigns/${campaignId}/orders/${id}`, headers: authed(owner) })).json()
    expect(detail.order).toMatchObject({ verification: 'UNVERIFIED', sourceStatus: 'Paid', sheetSaysPaid: true })

    const refused = await app.inject({ method: 'GET', url: '/pos/coupons/SIB-ONE1-0001', headers: authed(counter) })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('coupon:VERIFY_IN_VISTA')

    // Vista still never verifies on the sheet's word; once the owner does, it is an ordinary paid order.
    await post(`/rms/campaigns/${campaignId}/orders/${id}/verify`, { paymentDate: today() })
    const after = (await app.inject({ method: 'GET', url: `/rms/campaigns/${campaignId}/orders/${id}`, headers: authed(owner) })).json()
    expect(after.order).toMatchObject({ verification: 'VERIFIED', sheetSaysPaid: false })
    expect((await app.inject({ method: 'GET', url: '/pos/coupons/SIB-ONE1-0001', headers: authed(counter) })).statusCode).toBe(200)
  })

  it('writes nothing when write-back is off', async () => {
    const plain = await sheetCampaign(app, owner)
    await post(`/rms/campaigns/${plain}/sync`)
    const order = await prisma.campaignOrder.findFirstOrThrow({ where: { campaignId: plain, externalRef: 'BLOOM-ONE1' } })
    await post(`/rms/campaigns/${plain}/orders/${order.id}/verify`, { paymentDate: today() })
    expect(google.writes).toEqual([])
  })
})
