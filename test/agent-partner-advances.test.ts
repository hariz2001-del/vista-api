import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { authed, makeApp, makeBusiness } from './helpers.ts'
import { prisma } from '../src/db.ts'
let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })
async function setup() {
  const b = await makeBusiness(app), headers = authed(b.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'repayment' } })).json().key
  for (const [id, role] of [['111', 'OWNER'], ['222', 'BOOKKEEPER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId: id, role, name: role } })
  const agent = (user = '111') => ({ authorization: `Bearer ${key}`, 'x-telegram-user': user })
  const post = (url: string, payload: object, user = '111') => app.inject({ method: 'POST', url, payload, headers: agent(user) })
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: b.businessId } })
  const evidence = { fileId: 'verified-bank-file', scanVerified: true, reading: { date: '2026-11-02', totalSen: 24800, receiptNo: 'QR10000001', lines: [], flags: ['bank_screenshot'] } }
  await prisma.chopperStash.create({ data: { businessId: b.businessId, telegramUser: '111', receiptKey: 'R-76F8BD', data: evidence } })
  const body = { businessDate: '2026-11-02', amountSen: 24800, partnerBrandId: brand.id, receiptKey: 'R-76F8BD', bankReference: 'QR10000001', description: 'Coupon cash advanced while waiting for organiser claim', confirmedAlreadyPaid: true }
  return { b, headers, agent, post, body, evidence }
}
it('records a partner cash advance repayment once, attaches evidence, preserves the sign and never creates an operating expense', async () => {
  const s = await setup(), path = '/agent/partner-advances/repayments'
  expect((await s.post(path, s.body, '222')).statusCode).toBe(403)
  expect((await s.post(path, { ...s.body, confirmedAlreadyPaid: false })).statusCode).toBe(400)
  for (const changes of [{ amountSen: 9999 }, { bankReference: 'WRONG' }, { businessDate: '2026-11-03' }]) expect((await s.post(path, { ...s.body, ...changes })).statusCode).toBe(409)
  const other = await setup()
  expect((await other.post(path, s.body)).statusCode).toBe(404)
  await app.inject({ method: 'POST', url: '/rms/balance-checks', headers: s.headers, payload: { businessDate: '2026-11-01', bankSen: 100000 } })
  const p = await s.post('/agent/closing/preview', { businessDate: '2026-11-02', salesSen: 0, expensesSen: 0, closingBankSen: 124800 })
  expect(p.json().lines.closingBank).toMatchObject({ shortSen: 24800, differenceDirection: 'OVER' })
  await s.post('/agent/closing/confirm', { confirmationId: p.json().confirmationId })
  const responses = await Promise.all([s.post(path, s.body), s.post(path, s.body)])
  for (const r of responses) expect(r.statusCode, r.body).toBe(200)
  expect(responses.map(r => r.json().replayed).sort()).toEqual([false, true])
  const made = responses.find(r => !r.json().replayed)!.json()
  expect(made.repayment.detail).toMatchObject({ paymentStatus: 'PAID', classification: 'ADVANCE_REPAYMENT', sourceStatus: 'AWAITING_ADVANCE_AND_ORGANISER_RECORDS' })
  expect(made.closing.detail.evidence['transfer:QR10000001']).toBe('R-76F8BD')
  expect(made.closing.detail.comparison.lines.closingBank).toMatchObject({ shortSen: 49600, differenceDirection: 'OVER' })
  expect(made.closing.detail.flags).toContain('BANK_DIFFERENCE')
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(0)
  const ledger = await prisma.ledgerEntry.findMany({ where: { businessId: s.b.businessId } })
  expect(ledger).toHaveLength(1)
  expect(ledger[0]).toMatchObject({ direction: 'MONEY_OUT', category: 'LOAN_REPAYMENT', amountSen: 24800, brandId: s.body.partnerBrandId })
  // A second upload of the identical bank reference must reuse the transfer.
  await prisma.chopperStash.create({ data: { businessId: s.b.businessId, telegramUser: '111', receiptKey: 'R-4BECB1', data: s.evidence } })
  expect((await s.post(path, { ...s.body, receiptKey: 'R-4BECB1' })).json().replayed).toBe(true)
  expect((await s.post(path, { ...s.body, amountSen: 9999 })).statusCode).toBe(409)
  const list = await app.inject({ method: 'GET', url: path, headers: s.agent() })
  expect(list.json().repayments).toHaveLength(1)
})

it('blocks incoming evidence and a direction-corrected reference from being replayed as repayment', async () => {
  const s = await setup(), path = '/agent/partner-advances/repayments'
  await prisma.chopperStash.updateMany({ where: { businessId: s.b.businessId, receiptKey: s.body.receiptKey }, data: { data: { ...s.evidence, transferDirection: 'MONEY_IN' } } })
  expect((await s.post(path, s.body)).statusCode).toBe(409)
  await prisma.reconciliationCase.create({ data: { businessId: s.b.businessId, key: 'partner-repayment:QR10000001', kind: 'PARTNER_ADVANCE_RECEIPT', status: 'RESOLVED', detail: { ...s.body, direction: 'MONEY_IN' } } })
  expect((await s.post(path, s.body)).statusCode).toBe(409)
  expect(await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId } })).toBe(0)
})
