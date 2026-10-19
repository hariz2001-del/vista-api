import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../src/db.ts'
import { env } from '../src/env.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'

// Drive stand-in: scans by file ID.
const files: Record<string, Buffer> = { 'stash-scan-1': Buffer.from('stash one'), 'stash-scan-2': Buffer.from('stash two'), 'stash-photo-1': Buffer.from('photo one') }
vi.mock('../src/integrations/drive.ts', async original => ({ ...await original<any>(),
  withinFinances: vi.fn(async (id: string) => {
    if (!files[id]) throw new Error('Drive GET failed (404): File not found')
    return { id, name: id, mimeType: 'image/jpeg', size: String(files[id]!.length), webViewLink: `https://drive.google.com/file/d/${id}/view` }
  }),
  readFromDrive: vi.fn(async (id: string) => { if (!files[id]) throw new Error('Drive GET failed (404): File not found'); return files[id]! }),
}))
const sha = (id: string) => createHash('sha256').update(files[id]!).digest('hex')

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

const LINES = [
  { name: 'Susu pekat', quantityMilli: 12000, unitPriceSen: 320, amountSen: 3840 },
  { name: 'Milo 1.5kg', quantityMilli: 1000, unitPriceSen: 4290, amountSen: 4290 },
  { name: 'Sambal paste', quantityMilli: 2000, unitPriceSen: 850, amountSen: 1700 },
  { name: 'Roti burger', quantityMilli: 3000, unitPriceSen: 680, amountSen: 2040 },
]
const TOTAL = 11870

async function setup() {
  const business = await makeBusiness(app), owner = authed(business.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'chopper' } })).json().key
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId: '111', role: 'OWNER', name: 'owner' } })
  const bot = { authorization: 'Bearer ' + key, 'x-telegram-user': '111' }
  const brands = await prisma.brand.findMany({ where: { businessId: business.businessId }, orderBy: { sortOrder: 'asc' } })
  env.DRIVE_TEST_BUSINESS_ID = business.businessId
  return { business, owner, bot, food: brands[0]!, drinks: brands[1] ?? brands[0]! }
}
const receipt = (key: string, file: string) => ({ vendor: 'Mega Mart', date: '2026-10-18', receiptNo: 'MM-' + key.slice(2), totalSen: TOTAL, sha256: sha(file), driveFileId: file, fileName: `${key}_2026-10-18_Mega-Mart.jpg`, drivePath: 'Finances/Receipts/Stash/' + key })
const stashItem = (key: string, file: string, decisions = ['pending', 'pending', 'pending', 'pending']) => ({
  receiptKey: key, state: 'UNCONFIGURED', scanVerified: true, decisions, fileId: file, fileName: `${key}.jpg`, drivePath: 'Finances/Receipts/Stash/' + key, sha256: sha(file), originalFileId: 'stash-photo-1',
  reading: { vendor: 'Mega Mart', date: '2026-10-18', receiptNo: 'MM-' + key.slice(2), totalSen: TOTAL, paymentMethod: 'DUITNOW_QR', flags: [], lines: LINES },
})
const cash = (businessId: string) => prisma.ledgerEntry.findMany({ where: { businessId }, orderBy: { id: 'asc' } })

it('records a read receipt once as not categorised, then sorts it from the RMS and Telegram with no correction rows', async () => {
  const { business, owner, bot, food, drinks } = await setup()
  const record = () => app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-ABC123', receipt: receipt('R-ABC123', 'stash-scan-1'), lines: LINES, paymentMethod: 'DUITNOW_QR' } })
  const first = await record()
  expect(first.statusCode, first.body).toBe(200)
  expect((await record()).json()).toMatchObject({ alreadyRecorded: true, expenseId: first.json().expenseId })
  const recorded = await prisma.expense.findUniqueOrThrow({ where: { id: first.json().expenseId }, include: { items: true } })
  expect(recorded).toMatchObject({ uncategorised: true, amountSen: TOTAL, paidBy: 'STALL_FUNDS', brandId: null })
  expect(recorded.items).toHaveLength(4)
  expect((await cash(business.businessId)).map(l => [l.amountSen, l.expenseId])).toEqual([[TOTAL, recorded.id]])

  // Chopper mirrors its stash; the RMS lists it and shows the scan.
  const sync = await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-ABC123', 'stash-scan-1')] } })
  expect(sync.statusCode, sync.body).toBe(200)
  const list = (await app.inject({ method: 'GET', url: '/rms/stash', headers: owner })).json()
  expect(list.receipts[0]).toMatchObject({ receiptKey: 'R-ABC123', pendingSen: TOTAL, ready: true, recorded: true })
  const scan = await app.inject({ method: 'GET', url: '/rms/stash/R-ABC123/scan', headers: owner })
  expect(scan.statusCode).toBe(200); expect(scan.rawPayload.toString()).toBe('stash one')
  const photo = await app.inject({ method: 'GET', url: '/rms/stash/R-ABC123/scan?original=1', headers: owner })
  expect(photo.rawPayload.toString()).toBe('photo one')

  // The RMS books the drinks; the rest stays not categorised.
  const drinksBooking = { submissionId: randomUUID(), lines: [0, 1], expectedSen: 8130, brandId: drinks.id, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', paymentMethod: 'DUITNOW_QR', foodSplitPct: 0 }
  const booked = await app.inject({ method: 'POST', url: '/rms/stash/R-ABC123/book', headers: owner, payload: drinksBooking })
  expect(booked.statusCode, booked.body).toBe(200)
  const replay = await app.inject({ method: 'POST', url: '/rms/stash/R-ABC123/book', headers: owner, payload: drinksBooking })
  expect(replay.json()).toMatchObject({ alreadySubmitted: true })
  const twice = await app.inject({ method: 'POST', url: '/rms/stash/R-ABC123/book', headers: owner, payload: { ...drinksBooking, submissionId: randomUUID() } })
  expect(twice.json().error).toBe('agent:LINES_ALREADY_SORTED')
  const left = await prisma.expense.findUniqueOrThrow({ where: { id: recorded.id }, include: { items: true } })
  expect(left).toMatchObject({ uncategorised: true, amountSen: TOTAL - 8130 })
  expect(left.items.map(i => i.sortOrder)).toEqual([2, 3])

  // Chopper hears about it, and Telegram books the rest with the same core.
  const events = (await app.inject({ method: 'GET', url: '/agent/chopper/stash/events', headers: bot })).json().events
  expect(events[0]).toMatchObject({ receiptKey: 'R-ABC123', decisions: ['posted', 'posted', 'pending', 'pending'] })
  await app.inject({ method: 'POST', url: '/agent/chopper/stash/R-ABC123/ack', headers: bot, payload: { vistaRevision: events[0].vistaRevision } })
  expect((await app.inject({ method: 'GET', url: '/agent/chopper/stash/events', headers: bot })).json().events).toHaveLength(0)

  const rest = { receiptKey: 'R-ABC123', submissionId: randomUUID(), lines: [2, 3], receipt: receipt('R-ABC123', 'stash-scan-1'),
    entries: [{ businessDate: '2026-10-18', amountSen: 3740, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: food.id, foodSplitPct: 100, description: 'Sambal paste; Roti burger', paymentMethod: 'DUITNOW_QR', items: LINES.slice(2).map(({ name, quantityMilli, unitPriceSen }) => ({ name, quantityMilli, unitPriceSen })) }] }
  const preview = await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers: bot, payload: rest })
  expect(preview.statusCode, preview.body).toBe(200)
  const submit = await app.inject({ method: 'POST', url: '/agent/chopper/submit', headers: bot, payload: { submissionId: rest.submissionId, previewToken: preview.json().previewToken, payload: rest } })
  expect(submit.statusCode, submit.body).toBe(200)
  expect(submit.json().expenseIds).toEqual([recorded.id])

  const expenses = await prisma.expense.findMany({ where: { businessId: business.businessId }, orderBy: { createdAt: 'asc' } })
  expect(expenses.map(e => [e.amountSen, e.uncategorised, e.brandId])).toEqual([[3740, false, food.id], [8130, false, drinks.id]])
  const lines = await cash(business.businessId)
  expect(lines.every(l => l.direction === 'MONEY_OUT')).toBe(true)
  expect(lines.reduce((n, l) => n + l.amountSen, 0)).toBe(TOTAL)
  expect(lines).toHaveLength(2)
})

it('scraps lines off a not-categorised receipt, and removes it when nothing is left', async () => {
  const { business, owner, bot } = await setup()
  const recorded = (await app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-DEF456', receipt: receipt('R-DEF456', 'stash-scan-2'), lines: LINES } })).json()
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-DEF456', 'stash-scan-2')] } })
  const scrap = await app.inject({ method: 'POST', url: '/rms/stash/R-DEF456/scrap', headers: owner, payload: { lines: [3] } })
  expect(scrap.statusCode, scrap.body).toBe(200)
  expect((await prisma.expense.findUniqueOrThrow({ where: { id: recorded.expenseId } })).amountSen).toBe(TOTAL - 2040)
  expect((await cash(business.businessId))[0]!.amountSen).toBe(TOTAL - 2040)
  // Repeating from Telegram changes nothing.
  await app.inject({ method: 'POST', url: '/agent/chopper/scrap', headers: bot, payload: { receiptKey: 'R-DEF456', lines: [3], amountSen: 2040 } })
  expect((await prisma.expense.findUniqueOrThrow({ where: { id: recorded.expenseId } })).amountSen).toBe(TOTAL - 2040)

  // Settling the period waits until it is sorted.
  const close = await app.inject({ method: 'POST', url: '/rms/periods/close', headers: owner, payload: { startDate: '2026-10-01', endDate: '2026-10-31' } })
  expect([409, 400]).toContain(close.statusCode)

  await app.inject({ method: 'POST', url: '/rms/stash/R-DEF456/scrap', headers: owner, payload: { lines: [0, 1, 2] } })
  expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(0)
  expect(await cash(business.businessId)).toHaveLength(0)
})

it('edits and deletes an expense by changing its own cash line, never adding one', async () => {
  const { business, owner, food } = await setup()
  await prisma.accountSettings.updateMany({ where: { businessId: business.businessId }, data: { settlementEnabled: true } })
  const body = { businessDate: '2026-10-18', amountSen: 5000, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: food.id, foodSplitPct: 100, description: 'Ayam', items: [] }
  const made = await app.inject({ method: 'POST', url: '/rms/expenses', headers: owner, payload: body })
  expect(made.statusCode, made.body).toBe(200)
  const id = made.json().id
  await app.inject({ method: 'PUT', url: `/rms/expenses/${id}`, headers: owner, payload: { ...body, amountSen: 4500, description: 'Ayam segar' } })
  let lines = await cash(business.businessId)
  expect(lines.map(l => [l.direction, l.amountSen, l.description])).toEqual([['MONEY_OUT', 4500, 'Ayam segar']])
  const partner = await app.inject({ method: 'PUT', url: `/rms/expenses/${id}`, headers: owner, payload: { ...body, amountSen: 4500, paidBy: 'PARTNER_FOOD' } })
  expect(partner.statusCode, partner.body).toBe(200)
  expect(await cash(business.businessId)).toHaveLength(0)
  await app.inject({ method: 'PUT', url: `/rms/expenses/${id}`, headers: owner, payload: { ...body, amountSen: 4600 } })
  lines = await cash(business.businessId)
  expect(lines.map(l => l.amountSen)).toEqual([4600])
  await app.inject({ method: 'DELETE', url: `/rms/expenses/${id}`, headers: owner })
  expect(await cash(business.businessId)).toHaveLength(0)

  // An expense from before lines were linked finds its line by an exact match.
  const old = await app.inject({ method: 'POST', url: '/rms/expenses', headers: owner, payload: body })
  await prisma.ledgerEntry.updateMany({ where: { businessId: business.businessId }, data: { expenseId: null } })
  await app.inject({ method: 'PUT', url: `/rms/expenses/${old.json().id}`, headers: owner, payload: { ...body, amountSen: 5100 } })
  lines = await cash(business.businessId)
  expect(lines.map(l => [l.amountSen, l.expenseId])).toEqual([[5100, old.json().id]])
})
