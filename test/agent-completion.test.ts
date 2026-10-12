import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { sameVendor } from '../src/receipt-matching.ts'
import { randomUUID } from 'node:crypto'
import { authed, makeApp, makeBusiness, login, loginOwner, openShift, productByName, modifierByName, checkoutPayload, resetTransactional } from './helpers.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })
async function setup() {
  const b = await makeBusiness(app), owner = authed(b.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'Completion' } })).json().key
  for (const [telegramUserId, role] of [['111', 'OWNER'], ['222', 'VIEWER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId, role, name: role } })
  const headers = (user = '111') => ({ authorization: `Bearer ${key}`, 'x-telegram-user': user })
  const call = async (method: any, url: string, payload?: any) => {
    const r = await app.inject({ method, url, headers: headers(), payload }); expect(r.statusCode, r.body).toBe(200); return r.json()
  }
  const upload = async (seed: string, deferProcessing = false) => (await call('POST', '/agent/receipts', { imageBase64: Buffer.from(seed).toString('base64'), deferProcessing })).receipt.id
  await prisma.brand.create({ data: { businessId: b.businessId, name: 'Second brand', sortOrder: 1, colour: '#123456', softColour: '#eeeeee' } })
  const brands = await prisma.brand.findMany({ where: { businessId: b.businessId }, orderBy: { sortOrder: 'asc' } })
  return { b, owner, headers, call, upload, brands }
}
it('matches meaningful vendor identity and fresh photos, explains duplicates and preserves evidence', async () => {
  expect(sameVendor('BFEE BAKERY INGREDIENTS SDN BHD', 'SPEED MART SDN BHD')).toBe(false)
  expect(sameVendor('BFEE BAKERY INGREDIENTS SDN BHD', 'BFEE Bakery Ingredients')).toBe(true)
  const s = await setup(), a = await s.upload('original'), b = await s.upload('different photo')
  const reading = { vendor: 'BFEE Bakery Ingredients SDN BHD', receiptNo: 'INV-1', receiptDate: '2026-10-06', totalSen: 7610 }
  for (const rid of [a, b]) await s.call('PATCH', `/agent/receipts/${rid}/extraction`, reading)
  await s.call('PATCH', `/agent/receipts/${a}/extraction`, { extracted: { lines: [{ name: 'Corrected item' }] } })
  const preserved = await s.call('PATCH', `/agent/receipts/${a}/extraction`, { onlyMissing: true, vendor: 'Wrong OCR vendor', totalSen: 1, extracted: { lines: [{ name: 'Wrong OCR line' }], tax_rm: 0 } })
  expect(preserved.receipt).toMatchObject({ vendor: reading.vendor, totalSen: 7610, extracted: { lines: [{ name: 'Corrected item' }], tax_rm: 0 } })
  const duplicates = await s.call('GET', `/agent/receipts/${b}/duplicates`)
  expect(duplicates.candidates[0]).toMatchObject({ id: a, remainingSen: 7610 })
  expect(duplicates.candidates[0].reasons).toContain('same invoice number')
  const repeat = await s.call('POST', '/agent/receipts', { imageBase64: Buffer.from('original').toString('base64') })
  expect(repeat.duplicateReason).toBe('identical image bytes')
  expect((await s.call('POST', `/agent/receipts/${b}/reuse`, { canonicalId: a, reason: 'Same receipt, second brand allocation' })).canonicalReceiptId).toBe(a)
  expect((await prisma.receiptDocument.findUniqueOrThrow({ where: { id: b } })).status).toBe('REJECTED')
  expect(await prisma.receiptImage.findUnique({ where: { receiptId: b } })).not.toBeNull()
  const other = await setup()
  expect((await app.inject({ method: 'GET', url: `/agent/receipts/${a}/duplicates`, headers: other.headers() })).statusCode).toBe(404)
})
it('adds confirmed allocations later, totals existing entries and refuses stale repeated taps', async () => {
  const s = await setup(), rid = await s.upload('brand allocation')
  await s.call('PATCH', `/agent/receipts/${rid}/extraction`, { totalSen: 15000 })
  const entry = (amountSen: number, brandId: string) => ({ amountSen, brandId, businessDate: '2026-10-12', category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', foodSplitPct: 100, description: 'Brand allocation' })
  const entries = [entry(9000, s.brands[0]!.id)]
  const first = await s.call('POST', `/agent/receipts/${rid}/preview`, { entries })
  await s.call('POST', `/agent/receipts/${rid}/post`, { entries, previewToken: first.previewToken, allowTotalMismatch: true })
  const rest = [entry(6000, s.brands[1]!.id)]
  const preview = await s.call('POST', `/agent/receipts/${rid}/preview`, { entries: rest, append: true })
  expect(preview).toMatchObject({ allocatedSen: 9000, remainingSen: 6000, combinedTotalSen: 15000, matchesReceiptTotal: true })
  const payload = { entries: rest, append: true, previewToken: preview.previewToken }
  await s.call('POST', `/agent/receipts/${rid}/post`, payload)
  const twice = await app.inject({ method: 'POST', url: `/agent/receipts/${rid}/post`, headers: s.headers(), payload })
  expect(twice.statusCode).toBe(409)
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId, receiptDocumentId: rid } })).toBe(2)
})
it('leases durable jobs exclusively, retries failed work and keeps reconciliation cases across sessions', async () => {
  const s = await setup(), rid = await s.upload('queued', true)
  const job = await s.call('POST', '/agent/queue/claim', {})
  expect(job.job.receiptId).toBe(rid)
  expect((await s.call('POST', '/agent/queue/claim', {})).job).toBeNull()
  await s.call('POST', `/agent/queue/${job.job.id}/finish`, { leaseToken: job.leaseToken, error: 'Temporary OCR failure' })
  const retry = await s.call('POST', '/agent/queue/claim', {})
  expect(retry.job.attempts).toBe(2)
  await s.call('POST', `/agent/queue/${retry.job.id}/finish`, { leaseToken: retry.leaseToken })
  expect((await s.call('GET', '/agent/queue')).jobs).toHaveLength(0)
  const issue = { key: 'bank-2026-10-12', kind: 'BANK_DIFFERENCE', detail: { reportedSen: 245000, differenceSen: 100 } }
  const recorded = await s.call('POST', '/agent/reconciliation', issue)
  expect((await s.call('POST', '/agent/reconciliation', issue)).case.id).toBe(recorded.case.id)
  await s.call('PATCH', `/agent/reconciliation/${recorded.case.id}`, { status: 'RESOLVED', resolution: 'Explained by till cash; ledger unchanged' })
  expect((await s.call('GET', '/agent/reconciliation')).cases).toHaveLength(0)
  expect(await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId } })).toBe(0)
})
it('exposes scoped business records and computes only recorded, sourced recipe costs', async () => {
  const s = await setup()
  const time = await app.inject({ method: 'GET', url: '/agent/time', headers: s.headers('222') })
  expect(time.statusCode, time.body).toBe(200)
  expect(time.json()).toMatchObject({ timezone: 'Asia/Kuala_Lumpur', utcOffset: '+08:00', dayRolloverHour: 5 })
  expect(time.json().localNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  const category = await prisma.category.create({ data: { businessId: s.b.businessId, brandId: s.brands[0]!.id, name: 'Recipes' } })
  const product = await prisma.product.create({ data: { businessId: s.b.businessId, brandId: s.brands[0]!.id, categoryId: category.id, name: 'Tea', basePriceSen: 500 } })
  expect((await s.call('GET', `/agent/products/${product.id}/cost`)).costAvailable).toBe(false)
  await s.call('PUT', `/agent/products/${product.id}/cost`, { components: [{ name: 'Tea', unit: 'gram', quantityMilli: 10000, unitCostSen: 2 }, { name: 'Cup', unit: 'piece', quantityMilli: 1000, unitCostSen: 30 }], overheadSen: 10, source: 'Owner supplied purchase invoice and recipe', effectiveDate: '2026-10-12' })
  expect((await s.call('GET', `/agent/products/${product.id}/cost`))).toMatchObject({ costAvailable: true, costSen: 60, baseMarginSen: 440 })
  const catalog = await s.call('GET', '/agent/data')
  for (const resource of catalog.resources) await s.call('GET', `/agent/data/${resource}`)
  expect((await app.inject({ method: 'GET', url: '/agent/data/users', headers: s.headers() })).statusCode).toBe(404)
  expect((await app.inject({ method: 'GET', url: '/agent/data/products', headers: s.headers('222') })).statusCode).toBe(403)
  const other = await setup()
  expect((await app.inject({ method: 'GET', url: `/agent/products/${product.id}/cost`, headers: other.headers() })).statusCode).toBe(404)
})
it('counts legacy RMS attachments as supporting documents and does not mislabel legal suffixes as vendor matches', async () => {
  const s = await setup(), rid = await s.upload('bakery')
  await s.call('PATCH', `/agent/receipts/${rid}/extraction`, { vendor: 'BFEE Bakery Ingredients SDN BHD', receiptDate: '2026-10-06', totalSen: 7610 })
  const response = await app.inject({ method: 'POST', url: '/rms/expenses', headers: s.owner, payload: { businessDate: '2026-10-06', amountSen: 8195, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: s.brands[0]!.id, foodSplitPct: 100, description: 'Historical expense', vendor: 'Speed Mart SDN BHD' } })
  expect(response.statusCode, response.body).toBe(200)
  await prisma.expense.update({ where: { id: response.json().id }, data: { receiptUrl: 'https://drive.google.com/file/d/existing/view' } })
  expect((await s.call('GET', '/agent/audit?from=2026-10-06&to=2026-10-06')).expensesWithoutReceipt).toHaveLength(0)
  expect((await s.call('GET', `/agent/receipts/${rid}/matches`)).matches).toHaveLength(0)
})
it('returns actual addon snapshots and quantities from a real checkout, not current catalogue prices', async () => {
  await resetTransactional()
  const counter = await login(app), owner = authed(await loginOwner(app))
  const shift = await openShift(app, counter)
  const product = await productByName('Kopi Ais'), large = await modifierByName('Kopi Ais', 'Large'), shot = await modifierByName('Kopi Ais', 'Extra Shot')
  const day = getBusinessDate(new Date())
  const sale = await app.inject({ method: 'POST', url: '/checkout', headers: authed(counter), payload: checkoutPayload({ shiftId: shift, businessDate: day, clientTxnId: randomUUID(), claimedTotalSen: 1900, items: [{ product_id: product.id, quantity: 2, modifiers: [{ modifier_id: large.id }, { modifier_id: shot.id }] }] }) })
  expect(sale.statusCode, sale.body).toBe(200)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'Addon test' } })).json().key
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId: '333', role: 'OWNER', name: 'Owner' } })
  const response = await app.inject({ method: 'GET', url: `/agent/item-sales?from=${day}&to=${day}&productId=${product.id}`, headers: { authorization: `Bearer ${key}`, 'x-telegram-user': '333' } })
  expect(response.statusCode, response.body).toBe(200)
  const item = response.json().items[0]
  expect(item).toMatchObject({ qty: 2, baseSen: 1100, addonSen: 800, rungUpNetSen: 1900 })
  expect(item.addons).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Extra Shot', qty: 2, revenueSen: 500 }), expect.objectContaining({ name: 'Large', qty: 2, revenueSen: 300 })]))
})
