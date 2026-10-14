import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../src/db.ts'
import { env } from '../src/env.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'

// Drive stand-in: a few scans by file ID; "gone-file" has been deleted.
const files: Record<string, Buffer> = { 'scan-file-1': Buffer.from('scan one'), 'scan-file-1-copy': Buffer.from('scan one'), 'scan-file-2': Buffer.from('scan two'), 'scan-file-3': Buffer.from('scan three') }
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

async function setup() {
  const business = await makeBusiness(app), owner = authed(business.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'chopper' } })).json().key
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId: '111', role: 'OWNER', name: 'owner' } })
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId: '222', role: 'VIEWER', name: 'viewer' } })
  const as = (telegram: string) => ({ authorization: 'Bearer ' + key, 'x-telegram-user': telegram })
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: business.businessId } })
  env.DRIVE_TEST_BUSINESS_ID = business.businessId
  return { business, owner, bot: as('111'), viewer: as('222'), brand }
}
const entry = (brandId: string, amountSen: number, name = 'Fries') => ({ businessDate: '2026-10-10', amountSen, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId, foodSplitPct: 100, description: name, items: [{ name, quantityMilli: 1000, unitPriceSen: amountSen }] })
const booking = (receiptKey: string, file: string, entries: unknown[], totalSen = 1795) => ({
  receiptKey, submissionId: randomUUID(), entries,
  receipt: { vendor: '99 Speed Mart', date: '2026-10-10', receiptNo: '323421468', totalSen, sha256: sha(file), driveFileId: file, fileName: `${receiptKey}_2026-10-10_99-Speed-Mart.jpg`, drivePath: 'Finances/Receipts/Booked/2026/10/W2' },
})

it('previews without writing, submits exactly once, recovers, and refuses a changed payload', async () => {
  const { business, bot, viewer, brand } = await setup()
  const payload = booking('R-5AE50F', 'scan-file-1', [entry(brand.id, 1000)])
  expect((await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers: viewer, payload })).statusCode).toBe(403)
  const preview = await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers: bot, payload })
  expect(preview.statusCode, preview.body).toBe(200)
  expect(preview.json().entries[0]).toMatchObject({ vendor: '99 Speed Mart', receiptNo: '323421468', foodAmountSen: 1000 })
  expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(0)
  expect(await prisma.receiptDocument.count({ where: { businessId: business.businessId } })).toBe(0)

  const none = await app.inject({ method: 'GET', url: `/agent/chopper/submissions/${payload.submissionId}`, headers: viewer })
  expect(none.json()).toMatchObject({ status: 'none', expenseIds: [] })

  const submit = () => app.inject({ method: 'POST', url: '/agent/chopper/submit', headers: bot, payload: { submissionId: payload.submissionId, previewToken: preview.json().previewToken, payload } })
  const [a, b] = await Promise.all([submit(), submit()])
  expect(a.statusCode, a.body).toBe(200); expect(b.statusCode, b.body).toBe(200)
  expect(b.json().expenseIds).toEqual(a.json().expenseIds)
  const again = await submit()
  expect(again.json()).toMatchObject({ alreadySubmitted: true, expenseIds: a.json().expenseIds })
  expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(1)
  expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(1)

  const changed = { ...payload, entries: [entry(brand.id, 900)] }
  const reuse = await app.inject({ method: 'POST', url: '/agent/chopper/submit', headers: bot, payload: { submissionId: payload.submissionId, previewToken: preview.json().previewToken, payload: changed } })
  expect(reuse.statusCode).toBe(409); expect(reuse.json().error).toBe('agent:SUBMISSION_CHANGED')
  const fresh = { ...changed, submissionId: randomUUID() }
  const mismatch = await app.inject({ method: 'POST', url: '/agent/chopper/submit', headers: bot, payload: { submissionId: fresh.submissionId, previewToken: preview.json().previewToken, payload: fresh } })
  expect(mismatch.statusCode).toBe(409); expect(mismatch.json().error).toBe('agent:PREVIEW_MISMATCH')

  const recovered = await app.inject({ method: 'GET', url: `/agent/chopper/submissions/${payload.submissionId}`, headers: viewer })
  expect(recovered.json()).toMatchObject({ status: 'accepted', expenseIds: a.json().expenseIds, receipt: { receiptKey: 'R-5AE50F', driveFileId: 'scan-file-1', drivePath: 'Finances/Receipts/Booked/2026/10/W2' } })

  const image = await app.inject({ method: 'GET', url: `/rms/expenses/${a.json().expenseIds[0]}/receipt`, headers: authed(business.ownerToken) })
  expect(image.statusCode, image.body).toBe(200)
  expect(image.json().imageBase64).toBe(files['scan-file-1']!.toString('base64'))
})

it('books a split receipt in parts, flags real duplicates, and files without touching amounts', async () => {
  const { business, owner, bot, viewer, brand } = await setup()
  const post = async (payload: any) => {
    const preview = await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers: bot, payload })
    expect(preview.statusCode, preview.body).toBe(200)
    return app.inject({ method: 'POST', url: '/agent/chopper/submit', headers: bot, payload: { submissionId: payload.submissionId, previewToken: preview.json().previewToken, payload } })
  }
  const first = await post(booking('R-AAAAAA', 'scan-file-2', [entry(brand.id, 1000)]))
  const second = await post(booking('R-AAAAAA', 'scan-file-2', [entry(brand.id, 795, 'Sauce')]))
  expect(second.statusCode, second.body).toBe(200)
  const over = await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers: bot, payload: booking('R-AAAAAA', 'scan-file-2', [entry(brand.id, 1)]) })
  expect(over.json().error).toBe('agent:TOTAL_MISMATCH')
  expect(await prisma.receiptDocument.count({ where: { businessId: business.businessId } })).toBe(1)

  const dupes = await app.inject({ method: 'GET', url: `/agent/chopper/duplicates?receiptNo=323421468&date=2026-10-10&totalSen=1795&sha256=${sha('scan-file-2')}&receiptKey=R-AAAAAA`, headers: viewer })
  expect(dupes.statusCode, dupes.body).toBe(200)
  expect(dupes.json()).toHaveLength(2)
  for (const d of dupes.json()) expect(d).toMatchObject({ receiptKey: 'R-AAAAAA', sameReceiptKey: true, reasons: expect.arrayContaining(['invoice', 'image']) })
  const guess = await app.inject({ method: 'POST', url: '/agent/chopper/suggest', headers: viewer, payload: { vendor: '99 Speed Mart', lines: [{ name: 'FRIES' }, { name: 'Something new' }] } })
  expect(guess.statusCode, guess.body).toBe(200)
  expect(guess.json().lines[0]).toMatchObject({ category: 'RAW_MATERIALS', brandId: brand.id, source: 'item history' })
  expect(guess.json().lines[1]).toMatchObject({ category: null })
  expect(guess.json().overall).toMatchObject({ category: 'RAW_MATERIALS', brandId: brand.id })
  const byVendor = await app.inject({ method: 'POST', url: '/agent/chopper/suggest', headers: viewer, payload: { vendor: '99 speed mart', lines: [{ name: 'Never seen' }] } })
  expect(byVendor.json().overall).toMatchObject({ category: 'RAW_MATERIALS', brandId: brand.id, source: 'vendor history' })
  const otherKey = await post(booking('R-BBBBBB', 'scan-file-3', [entry(brand.id, 1795)]))
  expect(otherKey.json().error).toBe('agent:DUPLICATE_INVOICE')

  // Filed: the same file moved and renamed, then a different file holding the same image.
  const filed = await app.inject({ method: 'POST', url: '/agent/chopper/receipts/R-AAAAAA/filed', headers: bot, payload: { driveFileId: 'scan-file-2', fileName: 'R-AAAAAA_final.jpg', drivePath: 'Finances/Receipts/Booked/2026/10/W2' } })
  expect(filed.statusCode, filed.body).toBe(200)
  expect(filed.json()).toMatchObject({ receipt: { fileName: 'R-AAAAAA_final.jpg' }, expenseIds: expect.any(Array) })
  const wrong = await app.inject({ method: 'POST', url: '/agent/chopper/receipts/R-AAAAAA/filed', headers: bot, payload: { driveFileId: 'scan-file-3', fileName: 'x.jpg', drivePath: 'Finances' } })
  expect(wrong.json().error).toBe('agent:SCAN_CHANGED')
  expect((await prisma.expense.aggregate({ where: { businessId: business.businessId }, _sum: { amountSen: true } }))._sum.amountSen).toBe(1795)

  // Deleted in Drive: RMS says so and the expense stays.
  files['scan-file-gone'] = files['scan-file-2']!
  await app.inject({ method: 'POST', url: '/agent/chopper/receipts/R-AAAAAA/filed', headers: bot, payload: { driveFileId: 'scan-file-gone', fileName: 'gone.jpg', drivePath: 'Finances' } })
  delete files['scan-file-gone']
  const missing = await app.inject({ method: 'GET', url: `/rms/expenses/${first.json().expenseIds[0]}/receipt`, headers: owner })
  expect(missing.statusCode).toBe(404); expect(missing.json().message).toBe('Receipt image missing')
  expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(2)
})

it('links existing expenses to a scan once, changing nothing but the link', async () => {
  const { business, owner, bot } = await setup()
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: business.businessId } })
  const manual = await app.inject({ method: 'POST', url: '/rms/expenses', headers: owner, payload: entry(brand.id, 4200, 'Chicken') })
  expect(manual.statusCode, manual.body).toBe(200)
  const expenseId = manual.json().id ?? manual.json().expense?.id
  const before = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } })
  const ledger = await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })

  const preview = await app.inject({ method: 'POST', url: '/agent/chopper/link/preview', headers: bot, payload: { receiptKey: 'R-CCCCCC', expenseIds: [expenseId], driveFileId: 'scan-file-3', fileName: 'R-CCCCCC.jpg', drivePath: 'Finances/Receipts/Booked/2026/10/W2', sha256: sha('scan-file-3') } })
  expect(preview.statusCode, preview.body).toBe(200)
  expect(await prisma.receiptDocument.count({ where: { businessId: business.businessId } })).toBe(0)
  const submissionId = randomUUID()
  const link = () => app.inject({ method: 'POST', url: '/agent/chopper/link', headers: bot, payload: { previewToken: preview.json().previewToken, submissionId } })
  const done = await link(); expect(done.statusCode, done.body).toBe(200)
  expect((await link()).json()).toMatchObject({ alreadySubmitted: true, expenseIds: [expenseId] })
  const after = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } })
  expect({ ...after, receiptDocumentId: null }).toEqual({ ...before, receiptDocumentId: null })
  expect(after.receiptDocumentId).not.toBeNull()
  expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(ledger)
  const image = await app.inject({ method: 'GET', url: `/rms/expenses/${expenseId}/receipt`, headers: owner })
  expect(image.json().imageBase64).toBe(files['scan-file-3']!.toString('base64'))
})
