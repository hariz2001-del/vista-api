import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { authed, makeApp, makeBusiness } from './helpers.ts'
import { prisma } from '../src/db.ts'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

/** The owner's 1/11/26 closing, exactly as sent to Chopper. */
const CLOSING = { businessDate: '2026-11-01', salesSen: 10500, interestSen: 7, expensesSen: 0, openingBankSen: 127555, statedTotalSen: 138062, closingBankSen: 138062 }

it('corrects an outgoing coupon repayment in the closing without a second payment, invented income or changed bank balance', async () => {
  const s = await setup()
  const first = await s.ok('/agent/closing/preview', CLOSING)
  await s.ok('/agent/closing/confirm', { confirmationId: first.confirmationId })
  const owner = await prisma.user.findFirstOrThrow({ where: { businessId: s.b.businessId, role: 'OWNER' } })
  await prisma.expense.create({ data: { businessId: s.b.businessId, businessDate: new Date('2026-11-02'), amountSen: 53200, category: 'WAGES', paidBy: 'STALL_FUNDS', foodSplitPct: 100, foodAmountSen: 53200, drinksAmountSen: 0, description: 'Paid payroll', createdById: owner.id, isSettled: true } })
  for (const [direction, category, amountSen] of [['MONEY_IN', 'REVENUE', 25300], ['MONEY_IN', 'BANK_INTEREST', 10], ['MONEY_OUT', 'OPERATING_EXPENSE', 53200], ['MONEY_OUT', 'LOAN_REPAYMENT', 24800]] as const) await prisma.ledgerEntry.create({ data: { businessId: s.b.businessId, businessDate: new Date('2026-11-02'), direction, category, amountSen, description: category } })
  const original = { businessDate: '2026-11-02', salesSen: 25300, interestSen: 10, expensesSen: 53200, openingBankSen: 138062, statedTotalSen: 134972, closingBankSen: 134972 }
  const p = await s.ok('/agent/closing/preview', original)
  const old = await s.ok('/agent/closing/confirm', { confirmationId: p.confirmationId })
  expect(old.closing.detail.flags).toContain('OTHER_OUTFLOW_DIFFERENCE')
  const ledgerBefore = await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId } })
  const fixed = await s.ok('/agent/closing/preview', { ...original, otherOutflowsSen: 24800 })
  expect(fixed.lines.otherOutflows).toMatchObject({ closingSen: 24800, vistaSen: 24800, differenceSen: 0, entries: [expect.objectContaining({ category: 'LOAN_REPAYMENT', amountSen: 24800 })] })
  expect(fixed.lines.arithmetic).toMatchObject({ ownTotalSen: 85372, totalDifferenceSen: 49600, closingVsOwnTotalSen: 49600 })
  const saved = await s.ok('/agent/closing/confirm', { confirmationId: fixed.confirmationId })
  expect(saved).toMatchObject({ interest: 'unchanged', balanceCheck: 'unchanged' })
  expect(saved.closing.detail.input.otherOutflowsSen).toBe(24800)
  expect(saved.closing.detail.flags).not.toContain('OTHER_OUTFLOW_DIFFERENCE')
  expect(saved.closing.detail.flags).toContain('CLOSING_ARITHMETIC_DIFFERENCE')
  expect(saved.closing.detail.flags).toContain('BANK_DIFFERENCE')
  expect(await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId } })).toBe(ledgerBefore)
  expect(await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId, amountSen: 24800, direction: 'MONEY_IN' } })).toBe(0)
  // Owner corrects direction: reuse the same entry and clear only actual mismatches.
  const transfer = await prisma.ledgerEntry.findFirstOrThrow({ where: { businessId: s.b.businessId, category: 'LOAN_REPAYMENT' } })
  await prisma.ledgerEntry.update({ where: { id: transfer.id }, data: { direction: 'MONEY_IN', category: 'LOAN_PROCEEDS' } })
  const incoming = await s.ok('/agent/closing/preview', { ...original, otherInflowsSen: 24800, otherOutflowsSen: 0 })
  expect(incoming.lines.otherInflows).toMatchObject({ closingSen: 24800, vistaSen: 24800, differenceSen: 0 })
  expect(incoming.lines.arithmetic).toMatchObject({ ownTotalSen: 134972, totalDifferenceSen: 0 })
  expect(incoming.lines.closingBank).toMatchObject({ vistaExpectedSen: 134972, shortSen: 0, differenceDirection: 'BALANCED' })
  const corrected = await s.ok('/agent/closing/confirm', { confirmationId: incoming.confirmationId })
  for (const flag of ['BANK_DIFFERENCE', 'CLOSING_ARITHMETIC_DIFFERENCE', 'OTHER_INFLOW_DIFFERENCE', 'OTHER_OUTFLOW_DIFFERENCE']) expect(corrected.closing.detail.flags).not.toContain(flag)
  expect(corrected).toMatchObject({ interest: 'unchanged', balanceCheck: 'unchanged' })
  expect(await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId } })).toBe(ledgerBefore)
  const replay = await s.ok('/agent/closing/preview', { ...original, otherInflowsSen: 24800 })
  await s.ok('/agent/closing/confirm', { confirmationId: replay.confirmationId })
  expect(await prisma.ledgerEntry.count({ where: { businessId: s.b.businessId } })).toBe(ledgerBefore)

  expect(await prisma.balanceCheck.count({ where: { businessId: s.b.businessId, businessDate: new Date('2026-11-02') } })).toBe(1)
})

it('does not subtract backdated prior-day payroll and repayments again after an end-of-day bank anchor', async () => {
  const s = await setup()
  const owner = await prisma.user.findFirstOrThrow({ where: { businessId: s.b.businessId, role: 'OWNER' } })
  await prisma.balanceCheck.create({ data: { businessId: s.b.businessId, businessDate: new Date('2026-11-02'), bankSen: 134972, cashSen: 0, createdById: owner.id, createdAt: new Date('2026-11-14') } })
  for (const [category, amountSen] of [['OPERATING_EXPENSE', 53200], ['LOAN_REPAYMENT', 24800]] as const) await prisma.ledgerEntry.create({ data: { businessId: s.b.businessId, businessDate: new Date('2026-11-02'), direction: 'MONEY_OUT', category, amountSen, description: 'Backdated after bank check', entryAt: new Date('2026-11-15') } })
  await prisma.ledgerEntry.create({ data: { businessId: s.b.businessId, businessDate: new Date('2026-11-03'), direction: 'MONEY_IN', category: 'REVENUE', amountSen: 40900, description: '3 Nov sales' } })
  const expense = await app.inject({ method: 'POST', url: '/rms/expenses', headers: s.headers, payload: { businessDate: '2026-11-03', amountSen: 10300, category: 'ICE_GAS', paidBy: 'STALL_FUNDS', brandId: null, foodSplitPct: 100, description: '3 Nov expenses' } })
  expect(expense.statusCode, expense.body).toBe(200)
  const p = await s.ok('/agent/closing/preview', { businessDate: '2026-11-03', salesSen: 40900, expensesSen: 10300, openingBankSen: 134972, statedTotalSen: 165572, closingBankSen: 163172 })
  expect(p.lines.closingBank).toMatchObject({ vistaExpectedSen: 165572, closingSen: 163172, shortSen: -2400, differenceDirection: 'SHORT' })
  expect(p.lines.arithmetic.closingVsOwnTotalSen).toBe(-2400)
  expect(await prisma.balanceCheck.count({ where: { businessId: s.b.businessId, businessDate: new Date('2026-11-03') } })).toBe(0)
})

async function setup() {
  const b = await makeBusiness(app), headers = authed(b.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'closing' } })).json().key
  for (const [telegramUserId, role] of [['111', 'OWNER'], ['222', 'BOOKKEEPER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId, role, name: role } })
  const call = (url: string, payload: unknown, user = '111') => app.inject({ method: 'POST', url, payload: payload as object, headers: { authorization: `Bearer ${key}`, 'x-telegram-user': user } })
  const ok = async (url: string, payload: unknown) => { const r = await call(url, payload); expect(r.statusCode, r.body).toBe(200); return r.json() }
  // 31 Oct closing bank balance, keyed in the RMS; 1 Nov sales in the cash book.
  expect((await app.inject({ method: 'POST', url: '/rms/balance-checks', headers, payload: { businessDate: '2026-10-31', bankSen: 127555 } })).statusCode).toBe(200)
  for (const amountSen of [7700, 2800]) await prisma.ledgerEntry.create({ data: { businessId: b.businessId, businessDate: new Date('2026-11-01'), direction: 'MONEY_IN', amountSen, category: 'REVENUE', description: 'Sale' } })
  const interest = () => prisma.ledgerEntry.findMany({ where: { businessId: b.businessId, category: 'BANK_INTEREST' } })
  const checks = () => prisma.balanceCheck.findMany({ where: { businessId: b.businessId, businessDate: new Date('2026-11-01') }, orderBy: { createdAt: 'asc' } })
  return { b, headers, call, ok, interest, checks }
}

it('matches each closing line to its Vista row, then writes interest and the bank check only on confirm', async () => {
  const s = await setup()
  const preview = await s.ok('/agent/closing/preview', CLOSING)
  expect(preview.lines.sales).toEqual({ closingSen: 10500, vistaSen: 10500, differenceSen: 0 })
  expect(preview.lines.expenses.differenceSen).toBe(0)
  expect(preview.lines.openingBank).toEqual({ closingSen: 127555, vistaSen: 127555, vistaDate: '2026-10-31', differenceSen: 0 })
  expect(preview.lines.arithmetic).toMatchObject({ movementSen: 10507, ownTotalSen: 138062, totalDifferenceSen: 0, closingVsOwnTotalSen: 0 })
  expect(preview.lines.closingBank).toMatchObject({ closingSen: 138062, vistaExpectedSen: 138062, shortSen: 0, alreadyRecorded: false })
  expect(await s.interest()).toEqual([])
  expect(await s.checks()).toEqual([])

  const saved = await s.ok('/agent/closing/confirm', { confirmationId: preview.confirmationId })
  expect(saved).toMatchObject({ saved: true, interest: 'written', balanceCheck: 'recorded' })
  expect((await s.interest()).map((row) => [row.direction, row.amountSen, row.brandId])).toEqual([['MONEY_IN', 7, null]])
  expect((await s.checks()).map((row) => [row.bankSen, row.cashSen])).toEqual([[138062, 0]])
  expect((await s.call('/agent/closing/confirm', { confirmationId: preview.confirmationId })).statusCode).toBe(409)

  // Interest is cash book only: never a sale.
  const sales = (await app.inject({ method: 'GET', url: '/rms/snapshot', headers: s.headers })).json()
  expect(sales.balanceChecks.at(-1).bankSen).toBe(138062)

  // The same closing again changes nothing.
  const again = await s.ok('/agent/closing/preview', CLOSING)
  expect(again.lines.closingBank).toMatchObject({ shortSen: 0, alreadyRecorded: true })
  expect(again.lines.interest.willWrite).toBe(false)
  expect(await s.ok('/agent/closing/confirm', { confirmationId: again.confirmationId })).toMatchObject({ interest: 'unchanged', balanceCheck: 'unchanged' })
  expect(await s.interest()).toHaveLength(1)
  expect(await s.checks()).toHaveLength(1)

  // A corrected closing amends that day's interest line instead of adding one.
  const fixed = await s.ok('/agent/closing/preview', { ...CLOSING, interestSen: 8, statedTotalSen: 138063, closingBankSen: 138063 })
  expect(await s.ok('/agent/closing/confirm', { confirmationId: fixed.confirmationId })).toMatchObject({ interest: 'amended', balanceCheck: 'recorded' })
  expect((await s.interest()).map((row) => row.amountSen)).toEqual([8])
  expect((await s.checks()).map((row) => row.bankSen)).toEqual([138062, 138063])
})

it('reports mismatches line by line: sales, partner-paid expenses, opening, own arithmetic and short', async () => {
  const s = await setup()
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: s.b.businessId } })
  await app.inject({ method: 'POST', url: '/rms/expenses', headers: s.headers, payload: { businessDate: '2026-11-01', amountSen: 1200, category: 'ICE_GAS', paidBy: 'STALL_FUNDS', brandId: brand.id, foodSplitPct: 100, description: 'Ice' } })
  const r = await s.ok('/agent/closing/preview', { ...CLOSING, salesSen: 10000, openingBankSen: 127500, statedTotalSen: 138000, closingBankSen: 136000 })
  expect(r.lines.sales.differenceSen).toBe(-500)
  expect(r.lines.expenses).toMatchObject({ closingSen: 0, vistaStallPaidSen: 1200, differenceSen: -1200 })
  expect(r.lines.openingBank.differenceSen).toBe(-55)
  expect(r.lines.arithmetic).toMatchObject({ ownTotalSen: 137507, totalDifferenceSen: 493 })
  // Vista: 1275.55 + 105.00 − 12.00 + 0.07 = 1368.62; bank 1360.00 → 8.62 short.
  expect(r.lines.closingBank).toMatchObject({ vistaExpectedSen: 136862, shortSen: -862 })
})

it('is owner only, catches a stale preview, and never writes on preview', async () => {
  const s = await setup()
  expect((await s.call('/agent/closing/preview', CLOSING, '222')).statusCode).toBe(403)
  expect((await s.call('/agent/closing/preview', { ...CLOSING, salesSen: -1 })).statusCode).toBe(400)
  const first = await s.ok('/agent/closing/preview', CLOSING)
  const second = await s.ok('/agent/closing/preview', { ...CLOSING, interestSen: 9 })
  await s.ok('/agent/closing/confirm', { confirmationId: second.confirmationId })
  expect((await s.call('/agent/closing/confirm', { confirmationId: first.confirmationId })).statusCode).toBe(409)
  expect((await s.interest()).map((row) => row.amountSen)).toEqual([9])

  const other = await setup()
  expect((await other.call('/agent/closing/confirm', { confirmationId: first.confirmationId })).statusCode).toBe(404)
})

it('keeps a closing flagged when deferred, reuses later expenses, and resolves only after evidence', async () => {
  const s = await setup()
  const closing = { ...CLOSING, expensesSen: 1200, interestSen: 0, statedTotalSen: 136855, closingBankSen: 136855 }
  const p = await s.ok('/agent/closing/preview', closing)
  const saved = await s.ok('/agent/closing/confirm', { confirmationId: p.confirmationId })
  expect(saved.closing.detail.flags).toContain('EXPENSE_TOTAL_DIFFERENCE')
  expect(saved.closing.detail.expenseIds).toEqual([])
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: s.b.businessId } })
  expect((await app.inject({ method: 'POST', url: '/rms/expenses', headers: s.headers, payload: { businessDate: closing.businessDate, amountSen: 1200, category: 'ICE_GAS', paidBy: 'STALL_FUNDS', brandId: brand.id, foodSplitPct: 100, description: 'Ice', vendor: 'Ice Shop' } })).statusCode).toBe(200)
  // Refresh through the exported business-scoped function, same function as the worker route.
  const { refreshClosing } = await import('../src/routes/agent-closing.ts')
  const { forBusiness } = await import('../src/db.ts')
  const db = forBusiness(s.b.businessId)
  const input = { ...closing, cashSen: 0, otherOutflowsSen: 0, otherInflowsSen: 0 }
  let c = await refreshClosing(db, s.b.businessId, input)
  expect((c.detail as any).flags).toEqual(['AWAITING_RECEIPTS'])
  const e = await prisma.expense.findFirstOrThrow({ where: { businessId: s.b.businessId } })
  await prisma.expense.update({ where: { id: e.id }, data: { receiptUrl: 'https://drive.google.com/file/d/test-evidence/view' } })
  c = await refreshClosing(db, s.b.businessId, input)
  expect(c.status).toBe('RESOLVED')
  expect((c.detail as any).expenseIds).toEqual([e.id])
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(1)
})

it('interest evidence never creates an expense', async () => {
  const s = await setup()
  const p = await s.ok('/agent/closing/preview', CLOSING)
  const saved = await s.ok('/agent/closing/confirm', { confirmationId: p.confirmationId })
  expect(saved.closing.detail.flags).toEqual(['AWAITING_INTEREST_EVIDENCE'])
  await prisma.chopperStash.create({ data: { businessId: s.b.businessId, receiptKey: 'R-ABC123', telegramUser: '111', data: { fileId: 'bank-evidence', scanVerified: true, reading: { flags: ['bank_screenshot'] } } } })
  const evidence = await s.ok('/agent/closing/evidence', { businessDate: '2026-11-01', purpose: 'interest', receiptKey: 'R-ABC123' })
  expect(evidence.closing.status).toBe('RESOLVED')
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(0)
  expect((await s.call('/agent/closing/evidence', { businessDate: '2026-11-01', purpose: 'bank', receiptKey: 'R-FFFFFF' })).statusCode).toBe(409)
})

it('receipt-first expenses become members of a later closing without another expense', async () => {
  const s = await setup()
  expect((await app.inject({ method: 'POST', url: '/rms/expenses', headers: s.headers, payload: { businessDate: '2026-11-01', amountSen: 1200, category: 'ICE_GAS', paidBy: 'STALL_FUNDS', brandId: null, foodSplitPct: 50, description: 'Ice', receiptUrl: 'https://drive.google.com/file/d/test-receipt/view' } })).statusCode).toBe(200)
  const e = await prisma.expense.findFirstOrThrow({ where: { businessId: s.b.businessId } })
  await prisma.expense.update({ where: { id: e.id }, data: { receiptUrl: 'https://drive.google.com/file/d/test-receipt/view' } })
  const p = await s.ok('/agent/closing/preview', { ...CLOSING, interestSen: 0, expensesSen: 1200, statedTotalSen: 136855, closingBankSen: 136855 })
  expect(p.remainingExpensesSen).toBe(0)
  const saved = await s.ok('/agent/closing/confirm', { confirmationId: p.confirmationId })
  expect(saved.closing.detail.flags).toEqual([])
  expect(saved.closing.status).toBe('RESOLVED')
  expect(saved.closing.detail.expenseIds).toHaveLength(1)
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(1)
})

it('manual expenses require confirmation, survive repeated confirms and remain flagged for a receipt', async () => {
  const s = await setup()
  const input = { businessDate: '2026-11-01', amountSen: 1200, category: 'ICE_GAS', paidBy: 'STALL_FUNDS', brandId: null, foodSplitPct: 50, description: 'Ice', vendor: 'Ice Shop', paymentMethod: 'BANK_TRANSFER' }
  const p = await s.ok('/agent/closing/expense/preview', input)
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(0)
  const saved = await s.ok('/agent/closing/expense/confirm', { confirmationId: p.confirmationId })
  expect(saved.saved).toBe(true)
  expect(await s.ok('/agent/closing/expense/confirm', { confirmationId: p.confirmationId })).toMatchObject({ alreadySaved: true, expenseId: saved.expenseId })
  const duplicate = await s.ok('/agent/closing/expense/preview', input)
  expect(duplicate.existing).toHaveLength(1)
  expect((await s.call('/agent/closing/expense/confirm', { confirmationId: duplicate.confirmationId })).statusCode).toBe(409)
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(1)
})
