import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import type { Tx } from '../db.ts'
import { conflict, notFound } from '../errors.ts'
import { assertNotLocked, toDate, expenseBody, previewExpense, createExpense } from './rms.ts'

/**
 * The owner's daily closing, as typed into Telegram:
 *
 *     1/11/26 CLOSING
 *     Sales = RM 105 + RM0.07 interest
 *     Expenses = RM -
 *     Bank Balance = RM 1275.55            (opening: the bank the night before)
 *     +/- (Sales - Expenses) = RM 105.07
 *     Total = RM 1380.62
 *     Bank Balance = RM 1380.62            (closing: what the bank app shows)
 *
 * Chopper reads the figures; Vista checks each line against its own rows:
 *
 *   Sales          → ledger REVENUE − REFUND on that business date (what /agent/sales reports)
 *   Interest       → one BANK_INTEREST money-in line for that date (written on confirm)
 *   Expenses       → expenses paid from STALL_FUNDS that date (partner-paid ones never left the bank)
 *   Opening bank   → the newest balance_checks row before that date
 *   Closing bank   → a new balance_checks row for that date (written on confirm)
 *
 * Preview writes nothing but its audit row. Confirm comes only from the owner's
 * native button. Sending the same day again amends that day's interest line
 * rather than adding a second, and skips the bank check if it is unchanged.
 */

const DATE = z.iso.date()
const SEN = z.number().int().min(0).max(2_000_000_000)

const closingBody = z.object({
  businessDate: DATE,
  salesSen: SEN,
  interestSen: SEN.default(0),
  expensesSen: SEN,
  /** Repayments/drawings paid out separately from operating/capital expenses. */
  otherOutflowsSen: SEN.default(0),
  /** Non-sales funding already received; declaration never creates cash-book entries. */
  otherInflowsSen: SEN.default(0),
  /** The "Bank Balance" line before the sum; null when the message has none. */
  openingBankSen: SEN.nullable().default(null),
  /** The "Total" line, to check the owner's own arithmetic; null when absent. */
  statedTotalSen: SEN.nullable().default(null),
  /** The final "Bank Balance" line: what the bank app actually showed. */
  closingBankSen: SEN,
  cashSen: SEN.default(0),
}).strict()

type Closing = z.infer<typeof closingBody>

const iso = (value: Date) => value.toISOString().slice(0, 10)
const INTEREST_DESCRIPTION = 'Bank interest'

/** Everything confirm depends on, so a change between preview and confirm is caught. */
async function dayState(db: Tx, date: Date) {
  const [interest, checks] = await Promise.all([
    db.ledgerEntry.findMany({ where: { businessDate: date, category: 'BANK_INTEREST' }, orderBy: { id: 'asc' } }),
    db.balanceCheck.findMany({ where: { businessDate: date }, orderBy: { createdAt: 'asc' } }),
  ])
  return { interest, checks }
}

const stateKey = (state: Awaited<ReturnType<typeof dayState>>) => JSON.stringify({
  interest: state.interest.map((row) => [row.id.toString(), row.amountSen]),
  checks: state.checks.map((row) => row.id),
})

/** Recompute from actual expenses, never manufacture an expense for the declared total. */
export async function refreshClosing(db: Tx, businessId: string, input: Closing, evidence: Record<string, string> = {}) {
  const rows = await db.expense.findMany({ where: { businessDate: toDate(input.businessDate), paidBy: 'STALL_FUNDS' },
    select: { id: true, amountSen: true, vendor: true, description: true, category: true, receiptDocumentId: true, receiptUrl: true, uncategorised: true, paymentMethod: true,
      payslip: { select: { id: true, status: true, periodStart: true, periodEnd: true, paidOn: true, totalSen: true, staff: { select: { name: true } } } } } })
  const expenses = rows.map(e => ({ ...e, payslip: e.payslip ? { ...e.payslip,
    periodStart: iso(e.payslip.periodStart), periodEnd: iso(e.payslip.periodEnd), paidOn: e.payslip.paidOn ? iso(e.payslip.paidOn) : null } : null }))
  const actualSen = expenses.reduce((n, e) => n + e.amountSen, 0)
  // A paid payroll snapshot is the supporting record for wages, not a purchase receipt.
  const missing = expenses.filter(e => !e.receiptDocumentId && !e.receiptUrl &&
    !(e.category === 'WAGES' && e.payslip?.status === 'PAID' && e.payslip.totalSen === e.amountSen && e.payslip.paidOn === input.businessDate))
  const flags: string[] = []
  if (actualSen !== input.expensesSen) flags.push('EXPENSE_TOTAL_DIFFERENCE')
  if (missing.length) flags.push('AWAITING_RECEIPTS')
  if (expenses.some(e => e.uncategorised)) flags.push('AWAITING_CATEGORISATION')
  if (input.interestSen && !evidence.interest) flags.push('AWAITING_INTEREST_EVIDENCE')
  const comparison = (await compare(db, input)).result
  if (comparison.lines.coupons.inclusionPending.length) flags.push('COUPON_SALES_INCLUSION_PENDING')
  if (comparison.lines.coupons.awaitingCollectionEvidence.length) flags.push('AWAITING_COUPON_PAYMENT_EVIDENCE')
  if (comparison.lines.otherInflows.differenceSen) flags.push('OTHER_INFLOW_DIFFERENCE')
  if (comparison.lines.otherOutflows.differenceSen) flags.push('OTHER_OUTFLOW_DIFFERENCE')
  if (comparison.lines.sales.differenceSen) flags.push('SALES_DIFFERENCE')
  if (comparison.lines.closingBank.shortSen) flags.push('BANK_DIFFERENCE')
  if (comparison.lines.arithmetic.closingVsOwnTotalSen !== null && comparison.lines.arithmetic.closingVsOwnTotalSen !== 0) flags.push('CLOSING_ARITHMETIC_DIFFERENCE')
  const detail = { input, evidence, expenseIds: expenses.map(e => e.id), expenses, actualExpensesSen: actualSen,
    remainingExpensesSen: input.expensesSen - actualSen, missingReceiptExpenseIds: missing.map(e => e.id), flags, comparison,
    note: 'Day membership uses transaction date and STALL_FUNDS. Cash/unknown payment methods are included in the declared stall total; bank-only equivalence is not assumed. Never post a balancing expense.' }
  const status = flags.length ? 'OPEN' : 'RESOLVED'
  return db.reconciliationCase.upsert({ where: { businessId_key: { businessId, key: `closing:${input.businessDate}` } },
    create: { businessId, key: `closing:${input.businessDate}`, kind: 'DAILY_CLOSING', status, detail },
    update: { status, detail, resolution: flags.length ? null : 'Declared expense total and supporting evidence match.' } })
}

async function compare(db: Tx, input: Closing) {
  const date = toDate(input.businessDate)
  const [sales, expenses, previous, state, otherOutflows, otherInflows, couponCases] = await Promise.all([
    db.ledgerEntry.findMany({ where: { businessDate: date, category: { in: ['REVENUE', 'REFUND'] } }, select: { direction: true, amountSen: true } }),
    db.expense.findMany({ where: { businessDate: date }, select: { amountSen: true, paidBy: true } }),
    db.balanceCheck.findFirst({ where: { businessDate: { lt: date } }, orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }] }),
    dayState(db, date),
    db.ledgerEntry.findMany({ where: { businessDate: date, direction: 'MONEY_OUT', category: { in: ['LOAN_REPAYMENT', 'OWNER_DRAWING', 'CAMPAIGN_TRANSFER'] } }, select: { id: true, amountSen: true, category: true, description: true } }),
    db.ledgerEntry.findMany({ where: { businessDate: date, direction: 'MONEY_IN', category: { in: ['LOAN_PROCEEDS', 'CAPITAL_INJECTION', 'CAMPAIGN_TRANSFER'] } }, select: { id: true, amountSen: true, category: true, description: true } }),
    db.reconciliationCase.findMany({ where: { kind: { in: ['COUPON_RECEIVABLE', 'COUPON_PRIOR_COLLECTION'] } }, select: { id: true, detail: true } }),
  ])

  const vistaSalesSen = sales.reduce((sum, row) => sum + (row.direction === 'MONEY_IN' ? row.amountSen : -row.amountSen), 0)
  const stallExpensesSen = expenses.filter((row) => row.paidBy === 'STALL_FUNDS').reduce((sum, row) => sum + row.amountSen, 0)
  const partnerPaidSen = expenses.filter((row) => row.paidBy !== 'STALL_FUNDS').reduce((sum, row) => sum + row.amountSen, 0)
  const existingInterestSen = state.interest.reduce((sum, row) => sum + row.amountSen, 0)

  // The closing's own arithmetic, independent of Vista.
  const otherOutflowsSen = input.otherOutflowsSen ?? 0
  const vistaOtherOutflowsSen = otherOutflows.reduce((sum, row) => sum + row.amountSen, 0)
  const otherInflowsSen = input.otherInflowsSen ?? 0
  const vistaOtherInflowsSen = otherInflows.reduce((sum, row) => sum + row.amountSen, 0)
  const claims = couponCases.map(c => ({ id: c.id, ...(c.detail as any) }))
  const couponReceivableSen = claims.filter(c => c.businessDate === input.businessDate).reduce((n, c) => n + c.amountSen, 0)
  const collections = claims.filter(c => c.receivedDate === input.businessDate && c.paymentStatus === 'RECEIVED')
  const couponCollectionsSen = collections.filter(c => c.collectionLedgerId).reduce((n, c) => n + c.amountSen, 0)
  const couponAlreadyIncludedSen = collections.filter(c => c.includedInSales === true).reduce((n, c) => n + c.amountSen, 0)
  const couponInclusionPending = collections.filter(c => c.classificationStatus === 'AWAITING_SALES_INCLUSION').map(c => c.id)
  const movementBeforeCouponsSen = input.salesSen + input.interestSen + otherInflowsSen - input.expensesSen - otherOutflowsSen
  const movementSen = movementBeforeCouponsSen - couponReceivableSen + couponCollectionsSen
  const ownTotalSen = input.openingBankSen === null ? null : input.openingBankSen + movementSen

  // An end-of-day bank check already includes that whole business date.
  // Backdated entries must not be counted again merely because their database
  // insertion happened after the check was keyed in.
  let expectedSen: number | null = null
  if (previous) {
    const since = await db.ledgerEntry.findMany({
      where: {
        businessDate: { gt: previous.businessDate, lte: date },
      },
      select: { direction: true, amountSen: true },
    })
    const bookSen = since.reduce((sum, row) => sum + (row.direction === 'MONEY_IN' ? row.amountSen : -row.amountSen), 0)
    expectedSen = previous.bankSen + previous.cashSen + bookSen - existingInterestSen + input.interestSen
  }
  const actualSen = input.closingBankSen + input.cashSen
  const latestToday = state.checks.at(-1)

  return {
    state,
    result: {
      businessDate: input.businessDate,
      lines: {
        sales: { closingSen: input.salesSen, vistaSen: vistaSalesSen, differenceSen: input.salesSen - vistaSalesSen },
        interest: { closingSen: input.interestSen, vistaSen: existingInterestSen, willWrite: input.interestSen !== existingInterestSen },
        expenses: { closingSen: input.expensesSen, vistaStallPaidSen: stallExpensesSen, vistaPartnerPaidSen: partnerPaidSen, differenceSen: input.expensesSen - stallExpensesSen },
        coupons: { receivableSen: couponReceivableSen, collectedSen: couponCollectionsSen, alreadyIncludedInSalesSen: couponAlreadyIncludedSen, inclusionPending: couponInclusionPending,
          awaitingCollectionEvidence: collections.filter(c => c.evidenceStatus === 'AWAITING_PAYMENT_EVIDENCE').map(c => c.id),
          note: 'Coupon receivables defer existing sales from bank cash; collections settle them without another sale. Read actual sale and received dates.' },
        otherInflows: { closingSen: otherInflowsSen, vistaSen: vistaOtherInflowsSen, differenceSen: otherInflowsSen - vistaOtherInflowsSen,
          entries: otherInflows.map(row => ({ ...row, id: row.id.toString() })), note: 'Incoming funding and campaign money landing in the bank (CAMPAIGN_TRANSFER) are separate from sales. Existing entries are reused; closing confirmation never creates another receipt of funds.' },
        otherOutflows: { closingSen: otherOutflowsSen, vistaSen: vistaOtherOutflowsSen, differenceSen: otherOutflowsSen - vistaOtherOutflowsSen,
          entries: otherOutflows.map(row => ({ ...row, id: row.id.toString() })), note: 'Repayments, drawings and campaign money moved to the campaign wallet (CAMPAIGN_TRANSFER, e.g. SIB to TNG) are money out, separate from expenses. Existing entries are reused; confirming a closing never posts another repayment or transfer.' },
        openingBank: {
          closingSen: input.openingBankSen,
          vistaSen: previous ? previous.bankSen + previous.cashSen : null,
          vistaDate: previous ? iso(previous.businessDate) : null,
          differenceSen: input.openingBankSen !== null && previous ? input.openingBankSen - (previous.bankSen + previous.cashSen) : null,
        },
        arithmetic: {
          movementSen,
          ownTotalSen,
          statedTotalSen: input.statedTotalSen,
          totalDifferenceSen: ownTotalSen !== null && input.statedTotalSen !== null ?
            (input.statedTotalSen === input.openingBankSen! + movementBeforeCouponsSen ? 0 : input.statedTotalSen - ownTotalSen) : null,
          closingVsOwnTotalSen: ownTotalSen === null ? null : actualSen - ownTotalSen,
        },
        closingBank: {
          closingSen: actualSen,
          vistaExpectedSen: expectedSen,
          shortSen: expectedSen === null ? null : actualSen - expectedSen,
          differenceDirection: expectedSen === null ? 'UNKNOWN' : actualSen > expectedSen ? 'OVER' : actualSen < expectedSen ? 'SHORT' : 'BALANCED',
          interpretation: expectedSen === null ? 'No expected balance available.' : actualSen > expectedSen ? 'The recorded bank balance is ABOVE Vista expectations; this is an excess, not a shortfall.' : actualSen < expectedSen ? 'The recorded bank balance is BELOW Vista expectations; this is a shortfall.' : 'Recorded and expected balances match.',
          alreadyRecorded: Boolean(latestToday && latestToday.bankSen === input.closingBankSen && latestToday.cashSen === input.cashSen),
        },
      },
      note: 'Sales = cash-book REVENUE − REFUND for the business date. Expenses: only STALL_FUNDS leave the bank; partner-paid ones are owed, not paid. shortSen negative = bank holds less than Vista expects. Nothing is written until the owner presses Confirm.',
    },
  }
}

export async function agentClosingRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireAgent('OWNER') }
  const audit = (r: FastifyRequest, db: Tx, action: string, detail: unknown) =>
    db.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action, entityType: 'closing', entityId: (detail as { input: Closing }).input.businessDate, detail: JSON.parse(JSON.stringify(detail)) } })

  app.post('/agent/closing/expense/preview', owner, async r => {
    const input = expenseBody.parse(r.body)
    const preview = await previewExpense(r.db, r.businessId, input)
    const existing = await r.db.expense.findMany({ where: { businessDate: toDate(input.businessDate), amountSen: input.amountSen }, select: { id: true, description: true, vendor: true, receiptDocumentId: true } })
    const action = await r.db.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'closing.expense.preview', entityType: 'closing', entityId: input.businessDate, detail: JSON.parse(JSON.stringify({ input })) } })
    return { confirmationId: action.id.toString(), input, preview, existing }
  })
  app.post('/agent/closing/expense/confirm', owner, async r => {
    const { confirmationId } = z.object({ confirmationId: z.string().regex(/^\d{1,19}$/) }).parse(r.body)
    return r.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':manual-expense:' + confirmationId}))::text`
      const preview = await tx.agentAction.findFirst({ where: { id: BigInt(confirmationId), agentUserId: r.agentUser!.id, action: 'closing.expense.preview' } })
      if (!preview || Date.now() - preview.createdAt.getTime() > 30 * 60_000) throw conflict('agent:PREVIEW_STALE')
      const old = await tx.agentAction.findFirst({ where: { action: 'closing.expense.confirmed', entityId: confirmationId } })
      if (old) return { saved: true, alreadySaved: true, ...(old.detail as object) }
      const input = expenseBody.parse((preview.detail as any).input)
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':expense-date-amount:' + input.businessDate + ':' + input.amountSen}))::text`
      const existing = await tx.expense.findMany({ where: { businessDate: toDate(input.businessDate), amountSen: input.amountSen } })
      if (existing.length) throw conflict('agent:POSSIBLE_DUPLICATE', 'An expense with this date and amount already exists. Link or review that entry first.')
      const user = await tx.user.findFirstOrThrow({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
      const made = await createExpense(tx, r.businessId, user.id, input)
      await tx.reconciliationCase.create({ data: { businessId: r.businessId, key: `missing:${made.id}`, kind: 'MISSING_RECEIPT', detail: { expenseId: made.id, businessDate: input.businessDate, amountSen: input.amountSen, description: input.description } } })
      await tx.agentAction.create({ data: { businessId: r.businessId, agentUserId: r.agentUser!.id, action: 'closing.expense.confirmed', entityType: 'expense', entityId: confirmationId, detail: { expenseId: made.id } } })
      const c = await tx.reconciliationCase.findFirst({ where: { key: `closing:${input.businessDate}` } })
      if (c) { const d = c.detail as any; await refreshClosing(tx, r.businessId, d.input, d.evidence) }
      return { saved: true, expenseId: made.id }
    })
  })

  app.post('/agent/closing/preview', owner, async (r) => {
    const input = closingBody.parse(r.body)
    const { state, result } = await compare(r.db, input)
    let locked = false
    try { await assertNotLocked(r.db, input.businessDate) } catch { locked = true }
    const action = await audit(r, r.db, 'closing.preview', { input, state: stateKey(state) })
    const expenses = await r.db.expense.findMany({ where: { businessDate: toDate(input.businessDate), paidBy: 'STALL_FUNDS', receiptDocumentId: null, OR: [{ receiptUrl: null }, { receiptUrl: '' }] }, select: { id: true, amountSen: true, description: true } })
    return { confirmationId: action.id.toString(), locked, ...result, missingReceipts: expenses,
      remainingExpensesSen: result.lines.expenses.differenceSen }
  })

  app.get('/agent/closing/status', owner, async r => {
    const q = z.object({ date: DATE.optional() }).parse(r.query)
    const cases = await r.db.reconciliationCase.findMany({ where: { kind: 'DAILY_CLOSING', ...(q.date ? { key: `closing:${q.date}` } : {}) }, orderBy: { key: 'desc' }, take: 60 })
    const closings = []
    for (const c of cases) {
      const detail = c.detail as unknown as { input: Closing; evidence?: Record<string, string> }
      closings.push(await refreshClosing(r.db, r.businessId, detail.input, detail.evidence))
    }
    return { closings }
  })

  app.post('/agent/closing/evidence', owner, async r => {
    const body = z.object({ businessDate: DATE, purpose: z.enum(['interest', 'bank']), receiptKey: z.string().regex(/^R-[A-F0-9]{6}$/) }).parse(r.body)
    const c = await r.db.reconciliationCase.findFirst({ where: { key: `closing:${body.businessDate}`, kind: 'DAILY_CLOSING' } })
    if (!c) throw notFound('agent:CLOSING_NOT_FOUND')
    const stash = await r.db.chopperStash.findFirst({ where: { receiptKey: body.receiptKey } })
    const receipt = await r.db.receiptDocument.findFirst({ where: { receiptKey: body.receiptKey } })
    const data = stash?.data as { fileId?: string; scanVerified?: boolean } | undefined
    if (!(data?.fileId && data.scanVerified) && !(receipt?.scanDriveFileId || receipt?.driveFileId)) throw conflict('agent:EVIDENCE_NOT_READY')
    const detail = c.detail as unknown as { input: Closing; evidence?: Record<string, string> }
    const evidence = { ...detail.evidence, [body.purpose]: body.receiptKey }
    const updated = await refreshClosing(r.db, r.businessId, detail.input, evidence)
    await audit(r, r.db, 'closing.evidence', { input: detail.input, ...body })
    return { saved: true, closing: updated }
  })

  app.post('/agent/closing/confirm', owner, async (r) => {
    const { confirmationId } = z.object({ confirmationId: z.string().regex(/^\d{1,19}$/) }).parse(r.body)
    return r.db.$transaction(async (tx) => {
      const preview = await tx.agentAction.findFirst({ where: { id: BigInt(confirmationId), agentUserId: r.agentUser!.id, action: 'closing.preview' } })
      if (!preview) throw notFound('agent:PREVIEW_NOT_FOUND')
      if (Date.now() - preview.createdAt.getTime() > 30 * 60_000) throw conflict('agent:PREVIEW_STALE')
      const { input, state: before } = preview.detail as unknown as { input: Closing; state: string }
      const date = toDate(input.businessDate)
      // One closing per business day at a time; a concurrent confirm waits here.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${r.businessId + ':closing:' + input.businessDate}))::text`
      if (await tx.agentAction.findFirst({ where: { action: 'closing.confirmed', businessId: r.businessId, detail: { path: ['confirmationId'], equals: confirmationId } } })) {
        throw conflict('agent:ALREADY_CONFIRMED')
      }
      const state = await dayState(tx, date)
      if (stateKey(state) !== before) throw conflict('agent:PREVIEW_STALE', 'That day changed since the preview. Ask for a fresh one.')

      const existing = state.interest
      const existingSen = existing.reduce((sum, row) => sum + row.amountSen, 0)
      let interest: 'unchanged' | 'written' | 'amended' | 'removed' = 'unchanged'
      if (existingSen !== input.interestSen) {
        await assertNotLocked(tx, input.businessDate)
        const [keep, ...extra] = existing
        if (extra.length) await tx.ledgerEntry.deleteMany({ where: { id: { in: extra.map((row) => row.id) } } })
        if (input.interestSen === 0) {
          if (keep) await tx.ledgerEntry.delete({ where: { id: keep.id } })
          interest = 'removed'
        } else if (keep) {
          await tx.ledgerEntry.update({ where: { id: keep.id }, data: { amountSen: input.interestSen } })
          interest = 'amended'
        } else {
          await tx.ledgerEntry.create({ data: { businessId: r.businessId, businessDate: date, direction: 'MONEY_IN', amountSen: input.interestSen, category: 'BANK_INTEREST', description: INTEREST_DESCRIPTION } })
          interest = 'written'
        }
      }

      const latest = state.checks.at(-1)
      let balanceCheckId: string | null = null
      if (!latest || latest.bankSen !== input.closingBankSen || latest.cashSen !== input.cashSen) {
        // balance_checks.created_by_id is an RMS user; the owner pressed Confirm.
        const ownerUser = await tx.user.findFirstOrThrow({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
        const check = await tx.balanceCheck.create({ data: { businessId: r.businessId, businessDate: date, bankSen: input.closingBankSen, cashSen: input.cashSen, note: 'Daily closing via Chopper', createdById: ownerUser.id } })
        balanceCheckId = check.id
      }

      await audit(r, tx, 'closing.confirmed', { input, confirmationId, interest, balanceCheckId })
      const prior = await tx.reconciliationCase.findFirst({ where: { key: `closing:${input.businessDate}` } })
      const old = prior?.detail as { evidence?: Record<string, string>; input?: Closing } | undefined
      const evidence = { ...old?.evidence }
      if (old?.input?.interestSen !== input.interestSen) delete evidence.interest
      const closing = await refreshClosing(tx, r.businessId, input, evidence)
      return { saved: true, businessDate: input.businessDate, interest, interestSen: input.interestSen, balanceCheckId, balanceCheck: balanceCheckId ? 'recorded' : 'unchanged', closing }
    })
  })
}
