/**
 * The partner settlement maths, on the server.
 *
 * Ported from `rms-vista/src/domain/finance.ts`, so a locked period's figures
 * are computed here from the database and never taken from what a browser
 * sent. The RMS runs the same function for its live preview; the two must agree.
 *
 * Cashier corrections are folded into net sales. A cancelled sale is still in
 * the orders table — the original is never edited — so without this the
 * partners would be paid on money that was handed back to the customer.
 *
 * There is exactly one subtraction for the operating result:
 *
 *     Operating Result = Net Sales − Operating Expenses
 *
 * Capital purchases and owner drawings move real money but are not operating
 * expenses, so they never enter it.
 */

export type SettlementOrderLine = {
  brandId: string
  unitPriceSen: number
  modifierTotalSen: number
  quantity: number
  lineDiscountSen: number
  allocatedOrderDiscountSen: number
}

export type SettlementCorrection = {
  brandDeltas: ReadonlyArray<{ brandId: string; deltaSen: number }>
}

export type SettlementExpense = {
  amountSen: number
  category: string
  paidBy: 'STALL_FUNDS' | 'PARTNER_FOOD' | 'PARTNER_DRINKS'
  brandId: string | null
  foodAmountSen: number
  drinksAmountSen: number
  isSettled: boolean
}

export type SettlementLedgerEntry = {
  category: string
  brandId: string | null
  amountSen: number
}

export type SettlementClosure = { endDate: string; closingIouSen: number }

const NON_OPERATING = new Set(['CAPITAL_ASSET'])

export function isOperatingExpense(expense: SettlementExpense): boolean {
  return !NON_OPERATING.has(expense.category)
}

/**
 * Split a shared amount so the parts sum to exactly the whole. The second share
 * is derived by subtraction rather than a second rounding, which is what
 * guarantees no sen is invented or lost.
 */
export function splitShared(
  amountSen: number,
  foodPct: number,
): { foodSen: number; drinksSen: number } {
  const foodSen = Math.round((amountSen * foodPct) / 100)
  return { foodSen, drinksSen: amountSen - foodSen }
}

/** Net sales per brand: every line after its discounts, then every correction's delta. */
export function netSalesByBrand(
  lines: readonly SettlementOrderLine[],
  corrections: readonly SettlementCorrection[],
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const line of lines) {
    const net =
      (line.unitPriceSen + line.modifierTotalSen) * line.quantity -
      line.lineDiscountSen -
      line.allocatedOrderDiscountSen
    totals.set(line.brandId, (totals.get(line.brandId) ?? 0) + net)
  }
  for (const correction of corrections) {
    for (const delta of correction.brandDeltas) {
      totals.set(delta.brandId, (totals.get(delta.brandId) ?? 0) + delta.deltaSen)
    }
  }
  return totals
}

export type BrandFinancials = {
  brandId: string
  netSalesSen: number
  directExpensesSen: number
  sharedOverheadShareSen: number
  operatingExpensesSen: number
  netResultSen: number
}

export type TransferInstruction = {
  /** Positive: host → Food. Food owes the stall when the direction says so. */
  amountSen: number
  direction: 'HOST_PAYS_FOOD' | 'FOOD_OWES_HOST' | 'NOTHING'
}

export type SettlementSummary = {
  food: BrandFinancials
  drinks: BrandFinancials
  sharedOverheadSen: number
  /** Deficit carried in from previous periods, as a positive number. */
  openingIouSen: number
  /** Food's result after the carried deficit is offset against it. */
  offsetResultSen: number
  hostCommissionSen: number
  /** Deficit still unrecovered at the end of this period, as a positive number. */
  closingIouSen: number
  foodAdvancesSen: number
  drinksAdvancesSen: number
  foodDrawingsSen: number
  drinksDrawingsSen: number
  foodPayoutSen: number
  drinksPayoutSen: number
  transfer: TransferInstruction
}

export type SettlementInput = {
  orderLines: readonly SettlementOrderLine[]
  corrections: readonly SettlementCorrection[]
  /** Expenses dated inside the period. */
  expenses: readonly SettlementExpense[]
  /**
   * Every partner-paid expense still unreimbursed, regardless of date. An
   * advance from an earlier month is still owed when this one is settled.
   */
  outstandingAdvances: readonly SettlementExpense[]
  /** Ledger rows for the period. Only `OWNER_DRAWING` rows are read. */
  ledger: readonly SettlementLedgerEntry[]
  hostCommissionPct: number
  foodBrandId: string
  drinksBrandId: string
  openingIouSen: number
}

/**
 * The full amount a partner paid, not their counterparty's share: the expense
 * has already been charged against both brands through the split, so each side
 * has borne its portion there. Reimbursing only the other side's share would
 * make the payer bear their own portion twice.
 */
function advancesFor(expenses: readonly SettlementExpense[], paidBy: SettlementExpense['paidBy']) {
  return expenses
    .filter((expense) => expense.paidBy === paidBy && !expense.isSettled)
    .reduce((sum, expense) => sum + expense.amountSen, 0)
}

/** Cash a partner already took out during the period. Deducted from their payout. */
function drawingsFor(ledger: readonly SettlementLedgerEntry[], brandId: string): number {
  return ledger
    .filter((entry) => entry.category === 'OWNER_DRAWING' && entry.brandId === brandId)
    .reduce((sum, entry) => sum + entry.amountSen, 0)
}

/**
 * The deficit a period starts with: whatever the previous closure left unpaid.
 * Read from the closure chain rather than recomputed.
 */
export function openingDeficitFor(
  closures: readonly SettlementClosure[],
  startDate: string,
): number {
  const previous = closures
    .filter((closure) => closure.endDate < startDate)
    .toSorted((a, b) => a.endDate.localeCompare(b.endDate))
    .at(-1)
  return previous?.closingIouSen ?? 0
}

function transferInstruction(foodPayoutSen: number): TransferInstruction {
  if (foodPayoutSen > 0) return { amountSen: foodPayoutSen, direction: 'HOST_PAYS_FOOD' }
  if (foodPayoutSen < 0) return { amountSen: -foodPayoutSen, direction: 'FOOD_OWES_HOST' }
  return { amountSen: 0, direction: 'NOTHING' }
}

function brandFinancials(
  brandId: string,
  netSalesSen: number,
  expenses: readonly SettlementExpense[],
  pick: (expense: SettlementExpense) => number,
): BrandFinancials {
  let directExpensesSen = 0
  let sharedOverheadShareSen = 0

  for (const expense of expenses) {
    if (!isOperatingExpense(expense)) continue
    // The stored split is a snapshot from when the expense was logged, so a
    // settings change can never silently rewrite a past month.
    if (expense.brandId === brandId) directExpensesSen += expense.amountSen
    else if (expense.brandId === null) sharedOverheadShareSen += pick(expense)
  }

  const operatingExpensesSen = directExpensesSen + sharedOverheadShareSen
  return {
    brandId,
    netSalesSen,
    directExpensesSen,
    sharedOverheadShareSen,
    operatingExpensesSen,
    netResultSen: netSalesSen - operatingExpensesSen,
  }
}

/**
 * Settle one period.
 *
 * The carried deficit is absorbed once, before the commission is worked out,
 * and Food is paid on what is left. The host takes a cut of what remains; when
 * that is negative the cut is zero and Food's share is floored at zero too,
 * because the loss is carried forward rather than billed in cash.
 */
export function settlePeriod(input: SettlementInput): SettlementSummary {
  const netByBrand = netSalesByBrand(input.orderLines, input.corrections)

  const food = brandFinancials(
    input.foodBrandId,
    netByBrand.get(input.foodBrandId) ?? 0,
    input.expenses,
    (expense) => expense.foodAmountSen,
  )
  const drinks = brandFinancials(
    input.drinksBrandId,
    netByBrand.get(input.drinksBrandId) ?? 0,
    input.expenses,
    (expense) => expense.drinksAmountSen,
  )

  const sharedOverheadSen = input.expenses
    .filter((expense) => isOperatingExpense(expense) && expense.brandId === null)
    .reduce((sum, expense) => sum + expense.amountSen, 0)

  const offsetResultSen = food.netResultSen - input.openingIouSen
  const hostCommissionSen =
    offsetResultSen > 0 ? Math.round((offsetResultSen * input.hostCommissionPct) / 100) : 0
  const closingIouSen = offsetResultSen < 0 ? -offsetResultSen : 0

  const foodAdvancesSen = advancesFor(input.outstandingAdvances, 'PARTNER_FOOD')
  const drinksAdvancesSen = advancesFor(input.outstandingAdvances, 'PARTNER_DRINKS')
  const foodDrawingsSen = drawingsFor(input.ledger, input.foodBrandId)
  const drinksDrawingsSen = drawingsFor(input.ledger, input.drinksBrandId)

  // Floored: a loss carries forward as the IOU rather than being billed in cash.
  const foodShareSen = Math.max(0, offsetResultSen - hostCommissionSen)
  // Drawings are not floored: drawing more than you earned leaves you owing the stall.
  const foodPayoutSen = foodShareSen + foodAdvancesSen - foodDrawingsSen
  const drinksPayoutSen =
    drinks.netResultSen + hostCommissionSen + drinksAdvancesSen - drinksDrawingsSen

  return {
    food,
    drinks,
    sharedOverheadSen,
    openingIouSen: input.openingIouSen,
    offsetResultSen,
    hostCommissionSen,
    closingIouSen,
    foodAdvancesSen,
    drinksAdvancesSen,
    foodDrawingsSen,
    drinksDrawingsSen,
    foodPayoutSen,
    // The host is the Drinks partner: they keep all of Drinks and take the cut.
    drinksPayoutSen,
    transfer: transferInstruction(foodPayoutSen),
  }
}
