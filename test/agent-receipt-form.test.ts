import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'
let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })
async function setup() {
  const b = await makeBusiness(app), owner = authed(b.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'Receipt form' } })).json().key
  for (const [telegramUserId, role] of [['111', 'OWNER'], ['222', 'BOOKKEEPER'], ['333', 'VIEWER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId, role, name: role } })
  const headers = (user = '111') => ({ authorization: `Bearer ${key}`, 'x-telegram-user': user })
  const call = async (method: any, url: string, payload?: any, user = '111') => app.inject({ method, url, headers: headers(user), payload })
  const ok = async (method: any, url: string, payload?: any) => { const reply = await call(method, url, payload); expect(reply.statusCode, reply.body).toBe(200); return reply.json() }
  const rid = (await ok('POST', '/agent/receipts', { imageBase64: Buffer.from(b.businessId).toString('base64'), deferProcessing: true })).receipt.id
  await prisma.brand.create({ data: { businessId: b.businessId, name: 'Second', sortOrder: 1, colour: '#123456', softColour: '#eeeeee' } })
  const brands = await prisma.brand.findMany({ where: { businessId: b.businessId }, orderBy: { sortOrder: 'asc' } })
  const path = `/agent/receipts/${rid}/form`
  await ok('PATCH', `/agent/receipts/${rid}/extraction`, { vendor: 'Test supplier', receiptDate: '2026-10-12', receiptNo: 'INV-42', totalSen: 2500, extracted: { lines: [{ name: 'Ingredient', qty: 2, unit_price_rm: 10, amount_rm: 20 }, { name: 'Cup', qty: 1, unit_price_rm: 5, amount_rm: 5 }] } })
  let view = await ok('GET', path)
  const set = async (field: string, value: string | number | null, lineIndex?: number) => { view = await ok('PATCH', path, { version: view.form.version, field, value, ...(lineIndex === undefined ? {} : { lineIndex }) }); return view }
  return { b, rid, path, brands, call, ok, set, get view() { return view } }
}
it('uses live options, groups line settings, previews exact RMS fields and posts once', async () => {
  const s = await setup()
  expect(s.view.form.lines[0]).toMatchObject({ quantityMilli: 2000, unitPriceSen: 1000, category: null, brand: null })
  expect(s.view.fieldMap).toMatchObject({ category: 'Expense.category', funding: 'Expense.paidBy' })
  const incomplete = await s.call('POST', s.path + '/preview')
  expect(incomplete.statusCode).toBe(400); expect(incomplete.json().message).toContain('Choose a category for line 1')
  await s.set('category', 'RAW_MATERIALS', 0); await s.set('category', 'PACKAGING', 1)
  await s.set('brand', s.brands[0]!.id, 0); await s.set('brand', s.brands[1]!.id, 1)
  await s.set('method', 'DUITNOW_QR')
  const preview = await s.ok('POST', s.path + '/preview')
  expect(preview.entries).toHaveLength(2)
  expect(preview.entries[0]).toMatchObject({ amountSen: 2000, brandId: s.brands[0]!.id, category: 'RAW_MATERIALS', receiptNo: 'INV-42', vendor: 'Test supplier', businessDate: '2026-10-12', paymentMethod: 'DUITNOW_QR', items: [{ name: 'Ingredient', quantityMilli: 2000, unitPriceSen: 1000 }] })
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(0)
  const posted = await s.ok('POST', s.path + '/post', { confirmationId: preview.confirmationId })
  expect(posted.expenseIds).toHaveLength(2)
  expect((await s.call('POST', s.path + '/post', { confirmationId: preview.confirmationId })).statusCode).toBe(409)
  expect((await s.ok('GET', s.path)).readOnly).toBe(true)
  const records = await prisma.expense.findMany({ where: { businessId: s.b.businessId }, include: { items: true } })
  expect(records.every(r => r.receiptDocumentId === s.rid)).toBe(true)
  expect(records.reduce((sum, r) => sum + r.amountSen, 0)).toBe(2500)
})
it('isolates actors/businesses and rejects stale drafts, settings and readings', async () => {
  const s = await setup(), other = await setup()
  expect((await other.call('GET', s.path)).statusCode).toBe(404)
  expect((await s.call('GET', s.path, undefined, '333')).statusCode).toBe(403)
  await s.set('category', 'RAW_MATERIALS'); await s.set('brand', s.brands[0]!.id)
  const second = (await s.call('GET', s.path, undefined, '222')).json()
  expect(second.form.version).toBe(0); expect(second.form.lines[0].category).toBeNull()
  expect((await s.call('PATCH', s.path, { version: 0, field: 'category', value: 'PACKAGING' })).statusCode).toBe(409)
  expect((await s.call('PATCH', s.path, { version: s.view.form.version, field: 'brand', value: other.brands[0]!.id })).statusCode).toBe(409)
  const preview = await s.ok('POST', s.path + '/preview')
  expect((await s.call('POST', s.path + '/post', { confirmationId: preview.confirmationId }, '222')).statusCode).toBe(404)
  await s.set('method', 'CASH')
  expect((await s.call('POST', s.path + '/post', { confirmationId: preview.confirmationId })).statusCode).toBe(409)
  const fresh = await s.ok('POST', s.path + '/preview')
  await prisma.brand.update({ where: { id: s.brands[0]!.id }, data: { name: 'Renamed' } })
  expect((await s.call('POST', s.path + '/post', { confirmationId: fresh.confirmationId })).statusCode).toBe(409)
  await s.ok('PATCH', `/agent/receipts/${s.rid}/extraction`, { totalSen: 2600 })
  const reset = await s.ok('GET', s.path)
  expect(reset.readingChanged).toBe(true); expect(reset.form.lines).toHaveLength(3)
  expect(reset.form.lines[2]).toMatchObject({ adjustment: true, amountSen: 100, category: null })
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(0)
})
it('keeps explicit adjustments and refuses unknown quantities or inconsistent arithmetic', async () => {
  const s = await setup()
  await s.ok('PATCH', `/agent/receipts/${s.rid}/extraction`, { totalSen: 2400, extracted: { lines: [{ name: 'Purchase', qty: 1, unit_price_rm: 25, amount_rm: 25 }] } })
  let view = await s.ok('GET', s.path)
  expect(view.form.lines[1]).toMatchObject({ adjustment: true, amountSen: -100 })
  view = await s.ok('PATCH', s.path, { version: view.form.version, field: 'category', value: 'RAW_MATERIALS' })
  view = await s.ok('PATCH', s.path, { version: view.form.version, field: 'brand', value: s.brands[0]!.id })
  expect((await s.ok('POST', s.path + '/preview')).entriesTotalSen).toBe(2400)
  await s.ok('PATCH', `/agent/receipts/${s.rid}/extraction`, { totalSen: 2500, extracted: { lines: [{ name: 'Unreadable qty', unit_price_rm: 25, amount_rm: 25 }] } })
  view = await s.ok('GET', s.path)
  view = await s.ok('PATCH', s.path, { version: view.form.version, field: 'category', value: 'RAW_MATERIALS' })
  view = await s.ok('PATCH', s.path, { version: view.form.version, field: 'brand', value: s.brands[0]!.id })
  const reply = await s.call('POST', s.path + '/preview')
  expect(reply.statusCode).toBe(400); expect(reply.body).toContain('Missing values are not guessed')
})
