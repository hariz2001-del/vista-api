import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setGoogleFetch } from '../src/campaigns/google.ts'
import { prisma } from '../src/db.ts'
import { businessDateToUtc, getBusinessDate } from '../src/domain/business-date.ts'
import { fakeGoogle, sheetCampaign, sheetRow, type FakeGoogle } from './campaign-fixture.ts'
import { authed, makeApp, makeBusiness, resetTransactional, type TestBusiness } from './helpers.ts'

let app: FastifyInstance
let google: FakeGoogle
let business: TestBusiness
let owner: string
let agent: Record<string, string>
let png: Buffer

beforeAll(async () => {
  process.env.CAMPAIGN_SECRET_KEY = 'test-campaign-secret-key-that-is-long-enough-123'
  app = await makeApp()
  png = await sharp({ create: { width: 600, height: 1000, channels: 3, background: '#ffffff' } }).png().toBuffer()
})
beforeEach(async () => {
  await resetTransactional()
  google = fakeGoogle()
  business = await makeBusiness(app)
  owner = business.ownerToken
  const headers = authed(owner)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'chopper' } })).json().key
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId: '333', role: 'BOOKKEEPER', name: 'reader' } })
  agent = { authorization: `Bearer ${key}`, 'x-telegram-user': '333' }
})
afterAll(async () => {
  setGoogleFetch(null)
  await app.close()
  await prisma.$disconnect()
})

const as = (token: string) => authed(token)
const post = (url: string, payload: object = {}, headers = as(owner)) => app.inject({ method: 'POST', url, headers, payload })
const get = (url: string, headers = as(owner)) => app.inject({ method: 'GET', url, headers })

/** A campaign with the given sheet rows synced in; each order gets its own proof file. */
async function campaignWith(rows: Array<Parameters<typeof sheetRow>[0]>) {
  const id = await sheetCampaign(app, owner)
  for (const row of rows) {
    google.rows.push(sheetRow(row))
    if (row.fileId && !google.files.has(row.fileId)) {
      // Distinct bytes per file unless a test reuses the id on purpose.
      const bytes = await sharp(png).composite([{ input: Buffer.from(`<svg width="10" height="10"><text>${row.fileId}</text></svg>`), top: 0, left: 0 }]).png().toBuffer()
      google.files.set(row.fileId, { bytes, mimeType: 'image/png' })
    }
  }
  const synced = await post(`/rms/campaigns/${id}/sync`)
  expect(synced.statusCode, synced.body).toBe(200)
  return id
}

const orderRef = (ref: string) => prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: ref }, include: { proof: true } })

const reading = (over: Record<string, unknown> = {}) => ({
  looksLikeReceipt: true,
  readable: true,
  provider: 'Maybank',
  date: '2026-11-16',
  time: '21:35',
  amountSen: 2400,
  reference: 'MBB20261116ABC123',
  recipient: 'SARANG BURUNG HANTU',
  status: 'Successful',
  concerns: [],
  ...over,
})

async function readNext(extraction: Record<string, unknown>) {
  const claim = (await post('/agent/campaigns/proofs/claim', {}, agent)).json()
  expect(claim.proof).not.toBeNull()
  const result = await post(`/agent/campaigns/proofs/${claim.proof.id}/result`, { leaseToken: claim.proof.leaseToken, extraction }, agent)
  expect(result.statusCode, result.body).toBe(200)
  return { claim: claim.proof, result: result.json() }
}

describe('payment proof reading', () => {
  it('hands the reader the image and the amount owed, and passes a matching receipt', async () => {
    await campaignWith([{ code: 'BLOOM-OK01', fileId: 'file-ok-000001', submitted: '16/11/2026 21:40' }])
    const { claim, result } = await readNext(reading())
    expect(claim).toMatchObject({ orderRef: 'BLOOM-OK01', expectedSen: 2400, mimeType: 'image/jpeg', items: ['Crimson Charm (Rose set)'] })
    expect(Buffer.from(claim.imageBase64, 'base64').length).toBeGreaterThan(100)
    expect(result.flags).toEqual(['PASSED'])
    const order = await orderRef('BLOOM-OK01')
    expect(order.verification).toBe('UNVERIFIED') // the reader never decides
    expect(order.proof).toMatchObject({ readStatus: 'DONE', flags: ['PASSED'] })
    expect((order.proof!.extraction as { reference: string }).reference).toBe('MBB20261116ABC123')
    expect((await post('/agent/campaigns/proofs/claim', {}, agent)).json().proof).toBeNull()
  })

  it('flags an unrelated picture for review instead of rejecting it', async () => {
    await campaignWith([{ code: 'BLOOM-CAT1', fileId: 'file-cat-00001' }])
    const { result } = await readNext(reading({ looksLikeReceipt: false, readable: false, amountSen: null, provider: null, reference: null }))
    expect(result.flags).toEqual(['INVALID_IMAGE'])
    expect((await orderRef('BLOOM-CAT1')).verification).toBe('UNVERIFIED')
  })

  it('flags a wrong amount', async () => {
    await campaignWith([{ code: 'BLOOM-LOW1', fileId: 'file-low-00001' }])
    const { result } = await readNext(reading({ amountSen: 1900 }))
    expect(result.flags).toEqual(['AMOUNT_MISMATCH'])
    expect(result.summary).toContain('expected RM 24.00')
  })

  it('flags a reused transfer reference, and the same file on two orders', async () => {
    await campaignWith([
      { code: 'BLOOM-DUP1', fileId: 'file-dup-00001' },
      { code: 'BLOOM-DUP2', fileId: 'file-dup-00002' },
      { code: 'BLOOM-DUP3', fileId: 'file-dup-00001' },
    ])
    expect((await readNext(reading({ reference: 'REF-777-888' }))).result.flags).toEqual(['PASSED'])
    const second = await readNext(reading({ reference: 'ref 777-888' }))
    expect(second.result.flags).toContain('POSSIBLE_DUPLICATE')
    const third = await readNext(reading({ reference: 'OTHER-REF-1' }))
    expect(third.result.flags).toContain('POSSIBLE_DUPLICATE') // same file as BLOOM-DUP1
    expect(third.result.summary).toContain('BLOOM-DUP1')
  })

  it('stops doubting a payee the owner has already verified, but only that payee', async () => {
    const id = await campaignWith([
      { code: 'BLOOM-PY01', fileId: 'a1-payee-file', submitted: '16/11/2026 21:40' },
      { code: 'BLOOM-PY02', fileId: 'b2-payee-file', submitted: '16/11/2026 21:40' },
      { code: 'BLOOM-PY03', fileId: 'c3-payee-file', submitted: '16/11/2026 21:40' },
      { code: 'BLOOM-PY04', fileId: 'd4-payee-file', submitted: '16/11/2026 21:40' },
    ])
    const doubt = ['Recipient is a personal name, not clearly the shop.']
    // Nothing verified yet: the personal-name payee is still questioned.
    const first = await readNext(reading({ reference: 'PY-REF-0001', recipient: 'Ahmad Farid Bin Abdul Rahman Shah', concerns: doubt }))
    expect(first.result.flags).toEqual(['FLAGGED'])
    const verified = await post(`/rms/campaigns/${id}/orders/${(await orderRef('BLOOM-PY01')).id}/verify`, { paymentDate: '2026-11-16', paymentRef: 'PY-REF-0001' })
    expect(verified.statusCode, verified.body).toBe(200)

    // The same payee (the bank cut the name short) now passes...
    expect((await readNext(reading({ reference: 'PY-REF-0002', recipient: 'Ahmad Farid Bin Abdul', concerns: doubt }))).result.flags).toEqual(['PASSED'])
    // ...a different payee is still questioned...
    const stranger = await readNext(reading({ reference: 'PY-REF-0003', recipient: 'Ahmad Somebody Else', concerns: doubt }))
    expect(stranger.result.flags).toEqual(['FLAGGED'])
    // ...and a sign of editing is never waved through, even for the trusted payee.
    const edited = await readNext(reading({ reference: 'PY-REF-0004', recipient: 'Ahmad Farid Bin Abdul', concerns: [...doubt, 'Recipient name looks edited.'] }))
    expect(edited.result.flags).toEqual(['FLAGGED'])
    expect(edited.result.summary).toBe('Recipient name looks edited.')
  })

  it('gives up after five failed reads and asks for a look by eye', async () => {
    await campaignWith([{ code: 'BLOOM-BAD1', fileId: 'file-bad-00001' }])
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = (await post('/agent/campaigns/proofs/claim', {}, agent)).json().proof
      expect(claim).not.toBeNull()
      await post(`/agent/campaigns/proofs/${claim.id}/fail`, { leaseToken: claim.leaseToken, error: 'model timeout' }, agent)
    }
    expect((await post('/agent/campaigns/proofs/claim', {}, agent)).json().proof).toBeNull()
    expect((await orderRef('BLOOM-BAD1')).proof).toMatchObject({ readStatus: 'FAILED', flags: ['UNREADABLE'] })
  })

  it('refuses a result from a lost lease, and lets the owner dismiss or re-read', async () => {
    const id = await campaignWith([{ code: 'BLOOM-LSE1', fileId: 'file-lse-00001' }])
    const claim = (await post('/agent/campaigns/proofs/claim', {}, agent)).json().proof
    const stale = await post(`/agent/campaigns/proofs/${claim.id}/result`, { leaseToken: '00000000-0000-4000-8000-000000000000', extraction: reading() }, agent)
    expect(stale.statusCode).toBe(409)
    await post(`/agent/campaigns/proofs/${claim.id}/result`, { leaseToken: claim.leaseToken, extraction: reading({ amountSen: 100 }) }, agent)
    const order = await orderRef('BLOOM-LSE1')
    expect((await get(`/rms/campaigns/${id}/orders?flag=NEEDS_ATTENTION`)).json().total).toBe(1)
    await post(`/rms/campaigns/${id}/orders/${order.id}/proof/dismiss`)
    expect((await get(`/rms/campaigns/${id}/orders?flag=NEEDS_ATTENTION`)).json().total).toBe(0)
    await post(`/rms/campaigns/${id}/orders/${order.id}/proof/reread`)
    expect((await orderRef('BLOOM-LSE1')).proof!.readStatus).toBe('PENDING')
  })
})

describe('owner verification and the books', () => {
  const today = () => getBusinessDate(new Date())
  const daysAgo = (n: number) => {
    const d = businessDateToUtc(today())
    d.setUTCDate(d.getUTCDate() - n)
    return d.toISOString().slice(0, 10)
  }

  it('books revenue on the day the customer paid, not the day it was checked', async () => {
    const id = await campaignWith([{ code: 'BLOOM-PAY1', fileId: 'file-pay-00001' }])
    const order = await orderRef('BLOOM-PAY1')
    const paidOn = daysAgo(2)
    const verified = await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: paidOn, paymentRef: 'MBB123' })
    expect(verified.statusCode, verified.body).toBe(200)

    const entries = await prisma.ledgerEntry.findMany({ where: { businessId: business.businessId } })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ direction: 'MONEY_IN', category: 'REVENUE', amountSen: 2400 })
    expect(entries[0]!.businessDate.toISOString().slice(0, 10)).toBe(paidOn)
    const stored = await orderRef('BLOOM-PAY1')
    expect(stored).toMatchObject({ verification: 'VERIFIED', paidSen: 2400, paymentRef: 'MBB123', decidedByLabel: 'Management' })
    expect(stored.decidedAt!.toISOString().slice(0, 10)).not.toBe(paidOn)
  })

  it('never books the same order twice, however often it is verified or synced', async () => {
    const id = await campaignWith([{ code: 'BLOOM-TWC1', fileId: 'file-twc-00001' }])
    const order = await orderRef('BLOOM-TWC1')
    const body = { paymentDate: daysAgo(1) }
    const [a, b] = await Promise.all([post(`/rms/campaigns/${id}/orders/${order.id}/verify`, body), post(`/rms/campaigns/${id}/orders/${order.id}/verify`, body)])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])
    expect([a.json().repeated, b.json().repeated].sort()).toEqual([false, true])
    await post(`/rms/campaigns/${id}/sync`)
    await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, body)
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(1)
    // A different decision on a verified order is refused, not re-booked.
    const changed = await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: daysAgo(3) })
    expect(changed.statusCode).toBe(409)
  })

  it('needs the payment date, refuses the future and settled periods', async () => {
    const id = await campaignWith([{ code: 'BLOOM-DTE1', fileId: 'file-dte-00001' }])
    const order = await orderRef('BLOOM-DTE1')
    expect((await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, {})).statusCode).toBe(400)
    const future = await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: '2099-01-01' })
    expect(future.json().error).toBe('campaign:PAYMENT_DATE_FUTURE')

    const userId = (await prisma.user.findFirstOrThrow({ where: { businessId: business.businessId } })).id
    await prisma.periodClosure.create({
      data: {
        businessId: business.businessId,
        startDate: businessDateToUtc(daysAgo(10)),
        endDate: businessDateToUtc(daysAgo(5)),
        closedById: userId,
        foodNetSalesSen: 0, foodDirectExpensesSen: 0, foodOverheadShareSen: 0, foodNetResultSen: 0,
        openingIouSen: 0, hostCommissionSen: 0, closingIouSen: 0, foodPayoutSen: 0, drinksPayoutSen: 0,
      },
    })
    const locked = await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: daysAgo(7) })
    expect(locked.json().error).toBe('rms:PERIOD_LOCKED')
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(0)
  })

  it('undoes a verification with a reversing line, and can verify again', async () => {
    const id = await campaignWith([{ code: 'BLOOM-UND1', fileId: 'file-und-00001' }])
    const order = await orderRef('BLOOM-UND1')
    await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: daysAgo(2) })
    expect((await post(`/rms/campaigns/${id}/orders/${order.id}/unverify`, {})).statusCode).toBe(400) // needs a reason
    const undone = await post(`/rms/campaigns/${id}/orders/${order.id}/unverify`, { note: 'wrong customer' })
    expect(undone.statusCode, undone.body).toBe(200)
    const lines = await prisma.ledgerEntry.findMany({ where: { businessId: business.businessId }, orderBy: { id: 'asc' } })
    expect(lines.map((line) => [line.category, line.direction, line.amountSen, line.businessDate.toISOString().slice(0, 10)])).toEqual([
      ['REVENUE', 'MONEY_IN', 2400, daysAgo(2)],
      ['REFUND', 'MONEY_OUT', 2400, daysAgo(2)],
    ])
    await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: daysAgo(1) })
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(3)
    const trail = (await get(`/rms/campaigns/${id}/orders/${order.id}`)).json().history.map((entry: { action: string }) => entry.action)
    expect(trail.slice(0, 3)).toEqual(['order.verify', 'order.unverify', 'order.verify'])
  })

  it('rejects without touching the books, and can reopen', async () => {
    const id = await campaignWith([{ code: 'BLOOM-REJ1', fileId: 'file-rej-00001' }])
    const order = await orderRef('BLOOM-REJ1')
    await post(`/rms/campaigns/${id}/orders/${order.id}/reject`, { note: 'no such transfer' })
    expect((await orderRef('BLOOM-REJ1')).verification).toBe('REJECTED')
    expect((await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: daysAgo(1) })).statusCode).toBe(409)
    await post(`/rms/campaigns/${id}/orders/${order.id}/reopen`)
    expect((await orderRef('BLOOM-REJ1')).verification).toBe('UNVERIFIED')
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(0)
  })

  it('keeps verification away from the till', async () => {
    const id = await campaignWith([{ code: 'BLOOM-TIL1', fileId: 'file-til-00001' }])
    const order = await orderRef('BLOOM-TIL1')
    const counter = await post(`/rms/campaigns/${id}/orders/${order.id}/verify`, { paymentDate: daysAgo(1) }, as(business.counterToken))
    expect(counter.statusCode).toBe(403)
  })

  it('counts verified money and what is still owed in the summary', async () => {
    const id = await campaignWith([
      { code: 'BLOOM-SUM1', fileId: 'file-sum-00001', coupon: 'SIB-SUM1-0001' },
      { code: 'BLOOM-SUM2', fileId: 'file-sum-00002', coupon: 'SIB-SUM2-0001' },
    ])
    const one = await orderRef('BLOOM-SUM1')
    await post(`/rms/campaigns/${id}/orders/${one.id}/verify`, { paymentDate: daysAgo(1) })
    const summary = (await get(`/rms/campaigns/${id}/summary`)).json()
    expect(summary).toMatchObject({ verified: 1, unverified: 1, verifiedSen: 2400, expectedSen: 4800, outstandingSen: 1900 + 500 })
  })
})

describe('bulk actions', () => {
  it('rejects, dismisses and deletes only what is safe, and says why it skipped the rest', async () => {
    const id = await campaignWith([
      { code: 'BLOOM-BLK1', fileId: 'file-blk-00001' },
      { code: 'BLOOM-BLK2', fileId: 'file-blk-00002' },
      { code: 'BLOOM-BLK3', fileId: 'file-blk-00003' },
    ])
    const [a, b, c] = await Promise.all(['BLOOM-BLK1', 'BLOOM-BLK2', 'BLOOM-BLK3'].map(orderRef))
    await post(`/rms/campaigns/${id}/orders/${c!.id}/verify`, { paymentDate: getBusinessDate(new Date()) })

    const rejected = (await post(`/rms/campaigns/${id}/orders/bulk`, { action: 'reject', ids: [a!.id, c!.id] })).json()
    expect(rejected.done).toEqual([a!.id])
    expect(rejected.skipped).toEqual([expect.objectContaining({ id: c!.id, reason: expect.stringContaining('verified') })])

    const deleted = (await post(`/rms/campaigns/${id}/orders/bulk`, { action: 'delete', ids: [a!.id, b!.id, c!.id] })).json()
    expect(deleted.done.sort()).toEqual([a!.id, b!.id].sort())
    expect(deleted.skipped).toEqual([expect.objectContaining({ id: c!.id, reason: 'verified: part of the books' })])
    expect((await get(`/rms/campaigns/${id}/orders`)).json().total).toBe(1)
    // Soft: still there, and the audit trail keeps every step.
    expect(await prisma.campaignOrder.count({ where: { campaignId: id } })).toBe(3)
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(1)

    const restored = (await post(`/rms/campaigns/${id}/orders/bulk`, { action: 'restore', ids: [b!.id] })).json()
    expect(restored.done).toEqual([b!.id])

    const counter = await post(`/rms/campaigns/${id}/orders/bulk`, { action: 'delete', ids: [b!.id] }, as(business.counterToken))
    expect(counter.statusCode).toBe(403)
  })

  it('keeps a counter session away from every campaign route', async () => {
    const id = await campaignWith([])
    const counter = as(business.counterToken)
    for (const url of [`/rms/campaigns/${id}/orders`, `/rms/campaigns/${id}/summary`]) {
      expect((await get(url, counter)).statusCode).toBe(403)
    }
  })
})
