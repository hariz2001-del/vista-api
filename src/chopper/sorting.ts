import type { Tx } from '../db.ts'
import { conflict, notFound } from '../errors.ts'
import { lineTotalSen } from '../domain/expense-items.ts'
import {
  allocate,
  assertNotLocked,
  createExpense,
  itemRows,
  settlementEnabled,
  syncCashLine,
  type ExpenseBody,
} from '../routes/rms.ts'

/**
 * A receipt Chopper has read is recorded straight away as one expense, marked
 * not categorised: dated the receipt, for its total, paid from stall funds,
 * carrying every line. Sorting it — in the RMS or on Telegram — turns that one
 * expense into the final ones:
 *
 *   - the last lines sorted take the not-categorised expense over, in place;
 *   - lines sorted before that move out into their own expense;
 *   - scrapped lines are taken off it, and it goes once nothing is left.
 *
 * Like every expense edit, its cash line is amended in place, so sorting a
 * receipt leaves no "Corrected" rows in the cash book.
 */

export type ReadLine = { name: string; quantityMilli: number; unitPriceSen: number; amountSen: number }

type Pending = {
  id: string
  amountSen: number
  businessDate: Date
  paidBy: string
  category: string
  brandId: string | null
  foodSplitPct: number
  description: string
  items: Array<{ name: string; quantityMilli: number; unit: string | null; unitPriceSen: number; sortOrder: number }>
}

const dateOf = (value: Date) => value.toISOString().slice(0, 10)

/** The not-categorised expense still holding a receipt's unsorted lines, if any. */
export async function pendingExpense(tx: Tx, receiptDocumentId: string): Promise<Pending | null> {
  return tx.expense.findFirst({
    where: { receiptDocumentId, uncategorised: true },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })
}

/** The description a not-categorised expense carries: what is still on it. */
function describe(lines: Array<{ name: string }>): string {
  return ('Not categorised · ' + lines.map((line) => line.name).join('; ')).slice(0, 200) || 'Not categorised'
}

/** Record a freshly read receipt as one not-categorised expense. */
export async function recordUncategorised(
  tx: Tx,
  input: { businessId: string; ownerId: string; receiptDocumentId: string; date: string; vendor: string; receiptNo: string | null; totalSen: number; lines: ReadLine[]; paymentMethod: ExpenseBody['paymentMethod']; receiptKey: string },
): Promise<{ id: string }> {
  const settings = await tx.accountSettings.findUnique({ where: { businessId: input.businessId } })
  const addsUp = input.lines.length > 0 && input.lines.reduce((n, l) => n + l.amountSen, 0) === input.totalSen
    && input.lines.every((l) => l.quantityMilli > 0 && lineTotalSen(l.quantityMilli, l.unitPriceSen) === l.amountSen)
  const body: ExpenseBody = {
    businessDate: input.date,
    amountSen: input.totalSen,
    category: 'RAW_MATERIALS',
    paidBy: 'STALL_FUNDS',
    brandId: null,
    foodSplitPct: settings?.sharedOverheadFoodPct ?? 50,
    description: describe(input.lines),
    receiptNo: input.receiptNo,
    vendor: input.vendor,
    receiptTime: null,
    paymentMethod: input.paymentMethod,
    notes: `Recorded by Chopper · ${input.receiptKey}`,
    // Lines that do not add up are left off; the total still counts.
    items: addsUp ? input.lines.map((l) => ({ name: l.name.slice(0, 120), quantityMilli: l.quantityMilli, unit: null, unitPriceSen: l.unitPriceSen })) : [],
  }
  return createExpense(tx, input.businessId, input.ownerId, body, {
    receiptDocumentId: input.receiptDocumentId,
    uncategorised: true,
    lineNumbers: addsUp ? input.lines.map((_, i) => i) : undefined,
  })
}

/**
 * Sort some of a receipt's lines into a categorised expense, taking them off its
 * not-categorised one. `lines` are the receipt's line numbers; without them (an
 * older Chopper) the lines are matched by name and amount.
 */
export async function carve(
  tx: Tx,
  who: { businessId: string; ownerId: string; receiptDocumentId: string },
  pending: Pending,
  entry: ExpenseBody,
  lines: number[] | undefined,
): Promise<{ id: string }> {
  await assertNotLocked(tx, dateOf(pending.businessDate))
  if (entry.amountSen > pending.amountSen) throw conflict('agent:TOTAL_MISMATCH')
  const leftItems = remaining(pending.items, entry.items, lines)

  // The last of it: the not-categorised expense becomes this one, in place.
  if (entry.amountSen === pending.amountSen) {
    const withSettlement = await settlementEnabled(tx, who.businessId)
    const allocation = await allocate(tx, entry, withSettlement)
    const updated = await tx.expense.update({
      where: { id: pending.id },
      data: {
        businessDate: new Date(entry.businessDate + 'T00:00:00Z'),
        amountSen: entry.amountSen,
        category: entry.category,
        paidBy: entry.paidBy,
        brandId: entry.brandId,
        ...allocation,
        description: entry.description,
        receiptNo: entry.receiptNo,
        vendor: entry.vendor,
        paymentMethod: entry.paymentMethod,
        isSettled: entry.paidBy === 'STALL_FUNDS',
        uncategorised: false,
        items: { deleteMany: {}, create: itemRows(entry.items, lines) },
      },
    })
    await syncCashLine(tx, who.businessId, pending, updated)
    return { id: pending.id }
  }

  // Part of it: these lines get their own expense, and leave the not-categorised one.
  const made = await createExpense(tx, who.businessId, who.ownerId, entry, { receiptDocumentId: who.receiptDocumentId, lineNumbers: lines })
  await shrink(tx, who.businessId, pending, pending.amountSen - entry.amountSen, leftItems)
  return made
}

/** The not-categorised lines left once these are taken: by line number, else by name and amount. */
function remaining(items: Pending['items'], taken: ExpenseBody['items'], lines: number[] | undefined): Pending['items'] {
  if (lines) return items.filter((item) => !lines.includes(item.sortOrder))
  const left = [...items]
  for (const want of taken) {
    const at = left.findIndex((item) => item.name === want.name && item.quantityMilli === want.quantityMilli && item.unitPriceSen === want.unitPriceSen)
    if (at >= 0) left.splice(at, 1)
  }
  return left
}

/** Take scrapped lines off a receipt's not-categorised expense. */
export async function scrapFromPending(tx: Tx, businessId: string, pending: Pending, lines: number[], amountSen: number) {
  await assertNotLocked(tx, dateOf(pending.businessDate))
  if (amountSen > pending.amountSen) throw conflict('agent:TOTAL_MISMATCH')
  const left = pending.items.filter((item) => !lines.includes(item.sortOrder))
  await shrink(tx, businessId, pending, pending.amountSen - amountSen, left)
}

async function shrink(tx: Tx, businessId: string, pending: Pending, amountSen: number, items: Pending['items']) {
  if (amountSen <= 0) {
    await syncCashLine(tx, businessId, pending, null)
    await tx.expense.delete({ where: { id: pending.id } })
    return
  }
  const withSettlement = await settlementEnabled(tx, businessId)
  const allocation = await allocate(tx, { brandId: pending.brandId, amountSen, foodSplitPct: pending.foodSplitPct } as ExpenseBody, withSettlement)
  const description = describe(items)
  const updated = await tx.expense.update({
    where: { id: pending.id },
    data: {
      amountSen,
      ...allocation,
      description,
      items: {
        deleteMany: {},
        create: items.map((item) => ({
          name: item.name, quantityMilli: item.quantityMilli, unit: item.unit, unitPriceSen: item.unitPriceSen,
          totalSen: lineTotalSen(item.quantityMilli, item.unitPriceSen), sortOrder: item.sortOrder,
        })),
      },
    },
  })
  await syncCashLine(tx, businessId, pending, updated)
}

/** For tests and reads: a receipt's not-categorised expense, or a clear refusal. */
export async function requirePending(tx: Tx, receiptDocumentId: string): Promise<Pending> {
  const pending = await pendingExpense(tx, receiptDocumentId)
  if (!pending) throw notFound('rms:EXPENSE_NOT_FOUND')
  return pending
}
