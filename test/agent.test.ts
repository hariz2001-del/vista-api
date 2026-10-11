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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

function owner(b: TestBusiness, method: Method, url: string, payload?: unknown) {
  return app.inject({ method, url, headers: authed(b.ownerToken), payload: payload as object })
}

function agent(key: string, telegram: string, method: Method, url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}`, 'x-telegram-user': telegram },
    payload: payload as object,
  })
}

async function ok<T>(response: Promise<{ statusCode: number; body: string; json: () => unknown }>): Promise<T> {
  const done = await response
  expect(done.statusCode, done.body).toBe(200)
  return done.json() as T
}

/** A business with an agent key, a bookkeeper (111) and a viewer (222). */
async function setUp() {
  const b = await makeBusiness(app)
  const { key } = await ok<{ key: string }>(owner(b, 'POST', '/rms/agent/keys', { label: 'Sarang Hermes' }))
  await ok(owner(b, 'POST', '/rms/agent/users', { telegramUserId: '111', name: 'Kirko', role: 'BOOKKEEPER' }))
  await ok(owner(b, 'POST', '/rms/agent/users', { telegramUserId: '222', name: 'Viewer', role: 'VIEWER' }))
  return { b, key }
}

const image = (seed: string) => Buffer.from(`fake receipt image ${seed}`).toString('base64')

type Receipt = { id: string; status: string; totalSen: number | null; expenses?: Array<{ id: string }> }

describe('sarang ai — keys and who may use it', () => {
  it('lets only listed Telegram users in, each to their role', async () => {
    const { key } = await setUp()
    expect((await agent(key, '111', 'GET', '/agent/me')).json()).toMatchObject({ user: { name: 'Kirko', role: 'BOOKKEEPER' } })
    expect((await agent(key, '999', 'GET', '/agent/me')).json().error).toBe('agent:UNKNOWN_USER')
    expect((await agent('vak_not-a-key', '111', 'GET', '/agent/me')).statusCode).toBe(401)
    // A viewer reads but cannot upload.
    expect((await agent(key, '222', 'GET', '/agent/receipts')).statusCode).toBe(200)
    const refused = await agent(key, '222', 'POST', '/agent/receipts', { imageBase64: image('v') })
    expect(refused.json().error).toBe('agent:NOT_ALLOWED')
  })

  it('stops working the moment the key is revoked, and keeps only its hash', async () => {
    const { b, key } = await setUp()
    const listed = await ok<{ keys: Array<{ id: string }> }>(owner(b, 'GET', '/rms/agent'))
    expect(JSON.stringify(listed)).not.toContain(key)
    await ok(owner(b, 'POST', `/rms/agent/keys/${listed.keys[0]!.id}/revoke`))
    expect((await agent(key, '111', 'GET', '/agent/me')).statusCode).toBe(401)
  })

  it('offers the business’s own brands, split defaults and choices', async () => {
    const { b, key } = await setUp()
    await ok(owner(b, 'PUT', '/rms/settings', { businessName: 'Sarang', outletName: 'Sarang', settlementEnabled: false, dayRolloverHour: 5, sharedOverheadFoodPct: 70, hostCommissionPct: 30, capitalAssetFoodPct: 50 }))
    const options = await ok<{ brands: unknown[]; categories: Array<{ value: string }>; paidBy: Array<{ value: string }> }>(
      agent(key, '222', 'GET', '/agent/options'),
    )
    expect(options.brands.length).toBeGreaterThan(0)
    expect(options.categories.map((c) => c.value)).not.toContain('WAGES')
    expect(options.paidBy.map((p) => p.value)).toEqual(['STALL_FUNDS'])
  })
})

describe('sarang ai — receipts', () => {
  it('keeps a photo once, however often it arrives', async () => {
    const { key } = await setUp()
    const first = await ok<{ duplicate: boolean; receipt: Receipt }>(
      agent(key, '111', 'POST', '/agent/receipts', { imageBase64: image('a'), telegramChatId: '111', telegramMessageId: '5' }),
    )
    expect(first).toMatchObject({ duplicate: false, receipt: { status: 'UPLOADED' } })
    // Telegram delivering the same message again, and the same photo sent anew.
    const again = await ok<{ duplicate: boolean; receipt: Receipt }>(
      agent(key, '111', 'POST', '/agent/receipts', { imageBase64: image('other'), telegramChatId: '111', telegramMessageId: '5' }),
    )
    const resent = await ok<{ duplicate: boolean; receipt: Receipt }>(
      agent(key, '111', 'POST', '/agent/receipts', { imageBase64: image('a'), telegramChatId: '111', telegramMessageId: '6' }),
    )
    expect([again.duplicate, again.receipt.id, resent.duplicate, resent.receipt.id]).toEqual([true, first.receipt.id, true, first.receipt.id])
    // The photo is held until Drive takes it.
    const picture = await ok<{ imageBase64: string }>(agent(key, '222', 'GET', `/agent/receipts/${first.receipt.id}/image`))
    expect(picture.imageBase64).toBe(image('a'))
  })

  it('posts a read receipt only as previewed, all at once, once', async () => {
    const { b, key } = await setUp()
    const brands = await prisma.brand.findMany({ where: { businessId: b.businessId }, orderBy: { sortOrder: 'asc' } })
    const { receipt } = await ok<{ receipt: Receipt }>(agent(key, '111', 'POST', '/agent/receipts', { imageBase64: image('post') }))
    await ok(
      agent(key, '111', 'PATCH', `/agent/receipts/${receipt.id}/extraction`, {
        vendor: 'Tesco Seri Kembangan',
        receiptDate: '2026-10-09',
        receiptNo: 'INV-77',
        totalSen: 4560,
        reviewFlags: ['receiptNo'],
      }),
    )
    const entries = [
      {
        businessDate: '2026-10-09',
        amountSen: 4560,
        category: 'RAW_MATERIALS',
        paidBy: 'STALL_FUNDS',
        brandId: brands[0]!.id,
        foodSplitPct: 100,
        description: 'Milk and sugar',
        items: [
          { name: 'Milk', quantityMilli: 2000, unitPriceSen: 1580 },
          { name: 'Sugar', quantityMilli: 1000, unitPriceSen: 1400 },
        ],
      },
    ]
    const preview = await ok<{ previewToken: string; matchesReceiptTotal: boolean }>(
      agent(key, '111', 'POST', `/agent/receipts/${receipt.id}/preview`, { entries }),
    )
    expect(preview.matchesReceiptTotal).toBe(true)

    // Changed after the preview: refused until previewed again.
    const changed = await agent(key, '111', 'POST', `/agent/receipts/${receipt.id}/post`, {
      entries: [{ ...entries[0], description: 'Something else' }],
      previewToken: preview.previewToken,
    })
    expect(changed.json().error).toBe('agent:PREVIEW_STALE')

    const posted = await ok<{ expenseIds: string[]; receipt: Receipt }>(
      agent(key, '111', 'POST', `/agent/receipts/${receipt.id}/post`, { entries, previewToken: preview.previewToken }),
    )
    expect(posted.receipt.status).toBe('POSTED')
    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: posted.expenseIds[0]! }, include: { items: true } })
    expect(expense).toMatchObject({ amountSen: 4560, vendor: 'Tesco Seri Kembangan', receiptNo: 'INV-77', receiptDocumentId: receipt.id })
    expect(expense.items).toHaveLength(2)
    // Stall funds: the money left the cash book, exactly as an RMS entry would.
    expect(await prisma.ledgerEntry.count({ where: { businessId: b.businessId, amountSen: 4560, direction: 'MONEY_OUT' } })).toBe(1)

    // A second tap does nothing.
    const twice = await agent(key, '111', 'POST', `/agent/receipts/${receipt.id}/post`, { entries, previewToken: preview.previewToken })
    expect(twice.json().error).toBe('agent:RECEIPT_DONE')
    // The audit trail says who did it.
    expect(await prisma.agentAction.count({ where: { businessId: b.businessId, action: 'receipt.posted' } })).toBe(1)
  })

  it('links a receipt to expenses already in the books, and finds them as matches', async () => {
    const { b, key } = await setUp()
    const brands = await prisma.brand.findMany({ where: { businessId: b.businessId }, orderBy: { sortOrder: 'asc' } })
    const made = await ok<{ id: string }>(
      owner(b, 'POST', '/rms/expenses', {
        businessDate: '2026-10-08',
        amountSen: 1200,
        category: 'PACKAGING',
        paidBy: 'STALL_FUNDS',
        brandId: brands[0]!.id,
        foodSplitPct: 100,
        description: 'Cups',
        vendor: 'Kedai Plastik',
        receiptNo: 'KP-9',
      }),
    )
    const { receipt } = await ok<{ receipt: Receipt }>(agent(key, '111', 'POST', '/agent/receipts', { imageBase64: image('link') }))
    await ok(agent(key, '111', 'PATCH', `/agent/receipts/${receipt.id}/extraction`, { vendor: 'Kedai Plastik', receiptDate: '2026-10-08', receiptNo: 'KP-9', totalSen: 1200 }))
    const { matches } = await ok<{ matches: Array<{ expenseId: string; why: string[] }> }>(agent(key, '222', 'GET', `/agent/receipts/${receipt.id}/matches`))
    expect(matches[0]).toMatchObject({ expenseId: made.id })
    expect(matches[0]!.why).toContain('same receipt number')

    const linked = await ok<{ receipt: Receipt }>(agent(key, '111', 'POST', `/agent/receipts/${receipt.id}/link`, { expenseIds: [made.id] }))
    expect(linked.receipt).toMatchObject({ status: 'LINKED', expenses: [{ id: made.id }] })

    // Another business's key sees none of it.
    const other = await setUp()
    expect((await agent(other.key, '111', 'GET', `/agent/receipts/${receipt.id}`)).statusCode).toBe(404)
  })

  it('puts a receipt aside and brings it back in the open list', async () => {
    const { key } = await setUp()
    const { receipt } = await ok<{ receipt: Receipt }>(agent(key, '111', 'POST', '/agent/receipts', { imageBase64: image('skip') }))
    await ok(agent(key, '111', 'POST', `/agent/receipts/${receipt.id}/skip`, { reason: 'faded, ask Siti' }))
    const open = await ok<{ total: number; receipts: Receipt[] }>(agent(key, '222', 'GET', '/agent/receipts?status=OPEN&order=oldest&limit=5'))
    expect(open.receipts.map((r) => [r.id, r.status])).toEqual([[receipt.id, 'SKIPPED']])
  })
})

describe('sarang ai — questions', () => {
  it('answers sales, expenses, stock, cash and the receipt audit, read-only', async () => {
    const { b, key } = await setUp()
    const brands = await prisma.brand.findMany({ where: { businessId: b.businessId }, orderBy: { sortOrder: 'asc' } })
    await ok(
      owner(b, 'POST', '/rms/expenses', {
        businessDate: '2026-10-08', amountSen: 900, category: 'ICE_GAS', paidBy: 'STALL_FUNDS',
        brandId: brands[0]!.id, foodSplitPct: 100, description: 'Ice',
      }),
    )
    const range = '?from=2026-10-02&to=2026-10-08'
    const sales = await ok<{ days: unknown[]; totals: { netSen: number } }>(agent(key, '222', 'GET', `/agent/sales${range}`))
    expect(sales.days).toHaveLength(7)
    const expenses = await ok<{ expenses: Array<{ amountSen: number; hasReceiptPhoto: boolean }>; totals: { amountSen: number } }>(
      agent(key, '222', 'GET', `/agent/expenses${range}`),
    )
    expect(expenses.totals.amountSen).toBe(900)
    expect(expenses.expenses[0]).toMatchObject({ amountSen: 900, hasReceiptPhoto: false })
    expect((await ok<{ count: unknown }>(agent(key, '222', 'GET', '/agent/stock/latest'))).count).toBeNull()
    const cash = await ok<{ stallBalanceSen: number }>(agent(key, '222', 'GET', '/agent/cash'))
    expect(cash.stallBalanceSen).toBe(-900)
    const audit = await ok<{ expensesWithoutReceipt: unknown[] }>(agent(key, '222', 'GET', `/agent/audit${range}`))
    expect(audit.expensesWithoutReceipt).toHaveLength(1)
  })
})
