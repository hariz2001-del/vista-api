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

it('corrects a part-booked receipt: booked and unsorted lines follow, the cash book changes in place', async () => {
  const { business, owner, bot, drinks } = await setup()
  await app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-FEED01', receipt: receipt('R-FEED01', 'stash-scan-1'), lines: LINES } })
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-FEED01', 'stash-scan-1')] } })
  const booked = await app.inject({ method: 'POST', url: '/rms/stash/R-FEED01/book', headers: owner, payload: { submissionId: randomUUID(), lines: [0, 1], expectedSen: 8130, brandId: drinks.id, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', paymentMethod: null, foodSplitPct: 0 } })
  expect(booked.statusCode, booked.body).toBe(200)

  // Milo was RM 41.90, not 42.90; and a line was missed.
  const lines = LINES.map(({ name, quantityMilli, unitPriceSen }) => ({ name, quantityMilli, unitPriceSen }))
  lines[1] = { ...lines[1]!, unitPriceSen: 4190 }
  lines.push({ name: 'Plastik', quantityMilli: 1000, unitPriceSen: 300 })
  const edit = await app.inject({ method: 'PUT', url: '/rms/stash/R-FEED01/reading', headers: owner, payload: { vendor: 'Mega Mart Sri Muda', date: '2026-10-17', receiptNo: 'MM-1', totalSen: TOTAL - 100 + 300, lines } })
  expect(edit.statusCode, edit.body).toBe(200)
  expect(edit.json().addsUp).toBe(true)

  const expenses = await prisma.expense.findMany({ where: { businessId: business.businessId }, include: { items: true }, orderBy: { createdAt: 'asc' } })
  const drinksRow = expenses.find(e => !e.uncategorised)!, pending = expenses.find(e => e.uncategorised)!
  expect(drinksRow).toMatchObject({ amountSen: 8030, vendor: 'Mega Mart Sri Muda', receiptNo: 'MM-1' })
  expect(drinksRow.businessDate.toISOString().slice(0, 10)).toBe('2026-10-17')
  expect(pending.amountSen).toBe(1700 + 2040 + 300)
  expect(pending.items.map(i => i.sortOrder).sort()).toEqual([2, 3, 4])
  const cashLines = await cash(business.businessId)
  expect(cashLines.every(l => l.direction === 'MONEY_OUT')).toBe(true)
  expect(cashLines.reduce((n, l) => n + l.amountSen, 0)).toBe(TOTAL - 100 + 300)

  // The RMS shows it with the correction; Chopper is told the new reading.
  const detail = (await app.inject({ method: 'GET', url: '/rms/stash/R-FEED01', headers: owner })).json()
  expect(detail.lines).toHaveLength(5)
  expect(detail.lines[4]).toMatchObject({ name: 'Plastik', decision: 'pending' })
  const events = (await app.inject({ method: 'GET', url: '/agent/chopper/stash/events', headers: bot })).json().events
  expect(events[0].events.some((e: any) => e.type === 'reading')).toBe(true)
  // Chopper's older copy does not undo it before Chopper takes it in.
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-FEED01', 'stash-scan-1', ['posted', 'posted', 'pending', 'pending'])] } })
  expect((await app.inject({ method: 'GET', url: '/rms/stash/R-FEED01', headers: owner })).json().lines).toHaveLength(5)
})

it('re-categorises a booked part of a receipt and moves its cash line in place', async () => {
  const { business, owner, bot, food, drinks } = await setup()
  await app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-FEED02', receipt: receipt('R-FEED02', 'stash-scan-2'), lines: LINES } })
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-FEED02', 'stash-scan-2')] } })
  await app.inject({ method: 'POST', url: '/rms/stash/R-FEED02/book', headers: owner, payload: { submissionId: randomUUID(), lines: [0, 1, 2, 3], expectedSen: TOTAL, brandId: food.id, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', paymentMethod: null, foodSplitPct: 100 } })
  const detail = (await app.inject({ method: 'GET', url: '/rms/stash/R-FEED02', headers: owner })).json()
  expect(detail.sorted).toBe(true)
  const id = detail.expenses[0].id
  const fix = await app.inject({ method: 'PATCH', url: `/rms/stash/R-FEED02/expenses/${id}`, headers: owner, payload: { brandId: drinks.id, category: 'PACKAGING', paidBy: 'STALL_FUNDS', paymentMethod: 'CASH', foodSplitPct: 0 } })
  expect(fix.statusCode, fix.body).toBe(200)
  const e = await prisma.expense.findUniqueOrThrow({ where: { id }, include: { items: true } })
  expect(e).toMatchObject({ brandId: drinks.id, category: 'PACKAGING', paymentMethod: 'CASH', amountSen: TOTAL })
  expect(e.items.map(i => i.sortOrder).sort()).toEqual([0, 1, 2, 3])
  const lines = await cash(business.businessId)
  expect(lines.map(l => [l.direction, l.amountSen, l.brandId])).toEqual([['MONEY_OUT', TOTAL, drinks.id]])
  const sorted = (await app.inject({ method: 'GET', url: '/rms/stash?sorted=1', headers: owner })).json()
  expect(sorted.receipts.map((r: any) => r.receiptKey)).toContain('R-FEED02')
})

it('serves a small preview of a stashed scan for the receipt browser', async () => {
  const { default: sharp } = await import('sharp')
  files['stash-scan-1'] = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()
  const { owner, bot } = await setup()
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-AB0001', 'stash-scan-1')] } })
  const thumb = await app.inject({ method: 'GET', url: '/rms/stash/R-AB0001/thumb', headers: owner })
  expect(thumb.statusCode, thumb.body).toBe(200)
  expect(thumb.headers['content-type']).toBe('image/jpeg')
  const meta = await sharp(thumb.rawPayload).metadata()
  expect([meta.width, meta.height]).toEqual([360, 480])
  files['stash-scan-1'] = Buffer.from('stash one')
})

it('puts a held-back receipt into the books anyway, once, as not categorised', async () => {
  const { business, owner, bot } = await setup()
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [{ ...stashItem('R-AB0002', 'stash-scan-2'), duplicates: 1 }] } })
  const first = await app.inject({ method: 'POST', url: '/rms/stash/R-AB0002/record', headers: owner })
  expect(first.statusCode, first.body).toBe(200)
  expect((await app.inject({ method: 'POST', url: '/rms/stash/R-AB0002/record', headers: owner })).json()).toMatchObject({ alreadyRecorded: true })
  const expenses = await prisma.expense.findMany({ where: { businessId: business.businessId } })
  expect(expenses.map((e) => [e.uncategorised, e.amountSen])).toEqual([[true, TOTAL]])
  expect((await app.inject({ method: 'GET', url: '/rms/stash', headers: owner })).json().receipts[0]).toMatchObject({ recorded: true })
})

it('reviews duplicates: keep both, cancel the new one, or replace a stashed, booked or hand-typed one', async () => {
  const { business, owner, bot, food } = await setup()
  files['dup-a'] = Buffer.from('photo a'); files['dup-b'] = Buffer.from('photo b'); files['dup-c'] = Buffer.from('photo c')
  const item = (key: string, file: string) => ({ ...stashItem(key, file), reading: { ...stashItem(key, file).reading, receiptNo: 'INV-77' } })
  const rec = (key: string, file: string) => app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: key, receipt: { ...receipt(key, file), receiptNo: 'INV-77' }, lines: LINES } })
  const sync = (...items: unknown[]) => app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: items } })
  const dup = (key: string, body: object) => app.inject({ method: 'POST', url: `/rms/stash/${key}/duplicate`, headers: owner, payload: body })
  const uncategorised = () => prisma.expense.count({ where: { businessId: business.businessId, uncategorised: true } })

  // Two photos of one receipt in the stash: the second is flagged against the first.
  await rec('R-D00001', 'dup-a')
  await sync(item('R-D00001', 'dup-a'), item('R-D00002', 'dup-b'))
  const found = (await app.inject({ method: 'GET', url: '/rms/stash/R-D00002/duplicates', headers: owner })).json().others
  expect(found).toEqual([expect.objectContaining({ kind: 'booked', receiptKey: 'R-D00001' })]) // recorded, so in the books (not categorised)

  // Keep both: the flag goes.
  expect((await dup('R-D00002', { action: 'keep' })).statusCode).toBe(200)
  expect((await app.inject({ method: 'GET', url: '/rms/stash', headers: owner })).json().receipts.find((r: any) => r.receiptKey === 'R-D00002').duplicate).toBe(false)

  // Replace a stashed one: the old one leaves the books, the new one stays.
  const replaced = await dup('R-D00002', { action: 'replace', otherKey: 'R-D00001' })
  expect(replaced.statusCode, replaced.body).toBe(200)
  expect(replaced.json().otherKind).toBe('stash')
  expect(await uncategorised()).toBe(0)

  // Replace a booked one: the booking stays, its photo becomes the new one.
  await rec('R-D00002', 'dup-b')
  await app.inject({ method: 'POST', url: '/rms/stash/R-D00002/book', headers: owner, payload: { submissionId: randomUUID(), lines: [0, 1, 2, 3], expectedSen: TOTAL, brandId: food.id, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', paymentMethod: null, foodSplitPct: 100 } })
  await sync(item('R-D00002', 'dup-b'), item('R-D00003', 'dup-c'))
  await rec('R-D00003', 'dup-c').then(() => null)
  const swap = await dup('R-D00003', { action: 'replace', otherKey: 'R-D00002' })
  expect(swap.statusCode, swap.body).toBe(200)
  expect(swap.json()).toMatchObject({ otherKind: 'booked', oldFileId: 'dup-b' })
  const booked = await prisma.receiptDocument.findFirstOrThrow({ where: { businessId: business.businessId, receiptKey: 'R-D00002' }, include: { expenses: true } })
  expect([booked.sha256, booked.scanDriveFileId, booked.expenses.length]).toEqual([sha('dup-c'), 'dup-c', 1])
  expect(await prisma.receiptDocument.count({ where: { businessId: business.businessId, receiptKey: 'R-D00003' } })).toBe(0)
  expect(await uncategorised()).toBe(0)
  // Chopper hears what the RMS decided.
  const events = (await app.inject({ method: 'GET', url: '/agent/chopper/stash/events', headers: bot })).json().events
  expect(events.find((e: any) => e.receiptKey === 'R-D00003').events.at(-1)).toMatchObject({ type: 'duplicate', action: 'replace', otherKind: 'booked', otherKey: 'R-D00002' })

  // Replace a hand-typed expense: it gets the photo as its receipt.
  files['dup-d'] = Buffer.from('photo d')
  const manual = await app.inject({ method: 'POST', url: '/rms/expenses', headers: owner, payload: { businessDate: '2026-10-18', amountSen: 5555, category: 'RENT', paidBy: 'STALL_FUNDS', brandId: food.id, foodSplitPct: 100, description: 'Sewa', items: [] } })
  const typed = { ...stashItem('R-D00004', 'dup-d'), reading: { ...stashItem('R-D00004', 'dup-d').reading, receiptNo: null, totalSen: 5555, lines: [{ name: 'Sewa', quantityMilli: 1000, unitPriceSen: 5555, amountSen: 5555 }] }, decisions: ['pending'] }
  await sync(typed)
  const seen = (await app.inject({ method: 'GET', url: '/rms/stash/R-D00004/duplicates', headers: owner })).json().others
  expect(seen).toEqual([expect.objectContaining({ kind: 'manual', expenseIds: [manual.json().id] })])
  const linked = await dup('R-D00004', { action: 'replace', expenseIds: [manual.json().id] })
  expect(linked.statusCode, linked.body).toBe(200)
  const withPhoto = await prisma.expense.findUniqueOrThrow({ where: { id: manual.json().id }, include: { receiptDocument: true } })
  expect(withPhoto.receiptDocument?.receiptKey).toBe('R-D00004')

  // Cancel: the new one leaves the books.
  files['dup-e'] = Buffer.from('photo e')
  await app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-D00005', receipt: { ...receipt('R-D00005', 'dup-e'), receiptNo: 'INV-99' }, lines: LINES } })
  await sync({ ...item('R-D00005', 'dup-e'), reading: { ...item('R-D00005', 'dup-e').reading, receiptNo: 'INV-99' } })
  expect(await uncategorised()).toBe(1)
  expect((await dup('R-D00005', { action: 'cancel' })).statusCode).toBe(200)
  expect(await uncategorised()).toBe(0)
})

it('lists sorted receipts from the books, and opens one even without Chopper’s copy', async () => {
  const { business, owner, bot, food } = await setup()
  files['books-a'] = Buffer.from('books a')
  await app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-B00001', receipt: receipt('R-B00001', 'books-a'), lines: LINES } })
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-B00001', 'books-a')] } })
  await app.inject({ method: 'POST', url: '/rms/stash/R-B00001/book', headers: owner, payload: { submissionId: randomUUID(), lines: [0, 1], expectedSen: 8130, brandId: food.id, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', paymentMethod: null, foodSplitPct: 100 } })
  // Chopper's copy is gone (as for receipts sorted before it existed).
  await prisma.chopperStash.deleteMany({ where: { businessId: business.businessId } })
  const sorted = (await app.inject({ method: 'GET', url: '/rms/stash?sorted=1', headers: owner })).json().receipts
  expect(sorted).toEqual([expect.objectContaining({ receiptKey: 'R-B00001', bookedSen: 8130, pendingSen: TOTAL - 8130 })])
  const detail = (await app.inject({ method: 'GET', url: '/rms/stash/R-B00001', headers: owner })).json()
  expect(detail.lines.map((l: any) => [l.name, l.decision])).toEqual([['Susu pekat', 'posted'], ['Milo 1.5kg', 'posted'], ['Sambal paste', 'pending'], ['Roti burger', 'pending']])
  // And it can be corrected from there.
  const lines = LINES.map(({ name, quantityMilli, unitPriceSen }) => ({ name, quantityMilli, unitPriceSen }))
  lines[0] = { ...lines[0]!, unitPriceSen: 300 }
  const edit = await app.inject({ method: 'PUT', url: '/rms/stash/R-B00001/reading', headers: owner, payload: { vendor: 'Mega Mart', date: '2026-10-18', receiptNo: 'MM-1', totalSen: TOTAL - 240, lines } })
  expect(edit.statusCode, edit.body).toBe(200)
  const booked = await prisma.expense.findFirstOrThrow({ where: { businessId: business.businessId, uncategorised: false } })
  expect(booked.amountSen).toBe(8130 - 240)
})

it('spots a hand-keyed expense with no receipt a few days apart, for linking', async () => {
  const { owner, bot, food } = await setup()
  const typed = await app.inject({ method: 'POST', url: '/rms/expenses', headers: owner, payload: { businessDate: '2026-10-16', amountSen: TOTAL, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: food.id, foodSplitPct: 100, description: 'Barang Mega Mart', vendor: 'Mega Mart', items: [] } })
  files['hand-a'] = Buffer.from('hand a')
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-B00002', 'hand-a')] } })
  const others = (await app.inject({ method: 'GET', url: '/rms/stash/R-B00002/duplicates', headers: owner })).json().others
  expect(others).toEqual([expect.objectContaining({ kind: 'manual', expenseIds: [typed.json().id], reasons: ['same amount, 2 days apart', 'same shop'] })])
  const check = (await app.inject({ method: 'GET', url: `/agent/chopper/duplicates?date=2026-10-18&totalSen=${TOTAL}&receiptKey=R-B00002`, headers: bot })).json()
  expect(check).toEqual([expect.objectContaining({ expenseId: typed.json().id, receiptKey: null, reasons: ['keyed in by hand'] })])
  const link = await app.inject({ method: 'POST', url: '/rms/stash/R-B00002/duplicate', headers: owner, payload: { action: 'replace', expenseIds: [typed.json().id] } })
  expect(link.statusCode, link.body).toBe(200)
  expect((await prisma.expense.findUniqueOrThrow({ where: { id: typed.json().id }, include: { receiptDocument: true } })).receiptDocument?.receiptKey).toBe('R-B00002')
})

it('splits one receipt into bookings with their own settings, still one receipt', async () => {
  const { business, owner, bot, food, drinks } = await setup()
  files['split-a'] = Buffer.from('split a')
  await app.inject({ method: 'POST', url: '/agent/chopper/record', headers: bot, payload: { receiptKey: 'R-B00003', receipt: receipt('R-B00003', 'split-a'), lines: LINES } })
  await app.inject({ method: 'PUT', url: '/agent/chopper/stash', headers: bot, payload: { receipts: [stashItem('R-B00003', 'split-a')] } })
  const one = await app.inject({ method: 'POST', url: '/rms/stash/R-B00003/book', headers: owner, payload: { submissionId: randomUUID(), lines: [0, 1], expectedSen: 8130, brandId: drinks.id, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', paymentMethod: 'CASH', foodSplitPct: 0 } })
  expect(one.statusCode, one.body).toBe(200)
  const two = await app.inject({ method: 'POST', url: '/rms/stash/R-B00003/book', headers: owner, payload: { submissionId: randomUUID(), lines: [2, 3], expectedSen: TOTAL - 8130, brandId: food.id, category: 'PACKAGING', paidBy: 'STALL_FUNDS', paymentMethod: null, foodSplitPct: 100 } })
  expect(two.statusCode, two.body).toBe(200)
  const expenses = await prisma.expense.findMany({ where: { businessId: business.businessId }, include: { receiptDocument: true }, orderBy: { amountSen: 'desc' } })
  expect(expenses.map((e) => [e.amountSen, e.brandId, e.category, e.uncategorised])).toEqual([[8130, drinks.id, 'RAW_MATERIALS', false], [TOTAL - 8130, food.id, 'PACKAGING', false]].toSorted((a, b) => (b[0] as number) - (a[0] as number)))
  expect(new Set(expenses.map((e) => e.receiptDocument?.receiptKey))).toEqual(new Set(['R-B00003']))
})
