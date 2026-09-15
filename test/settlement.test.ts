import { describe, expect, it } from 'vitest'
import {
  netSalesByBrand,
  openingDeficitFor,
  settlePeriod,
  splitShared,
  type SettlementExpense,
  type SettlementInput,
} from '../src/domain/settlement.ts'

const FOOD = 'brand-food'
const DRINKS = 'brand-drinks'

function line(brandId: string, netSen: number) {
  return {
    brandId,
    unitPriceSen: netSen,
    modifierTotalSen: 0,
    quantity: 1,
    lineDiscountSen: 0,
    allocatedOrderDiscountSen: 0,
  }
}

function expense(overrides: Partial<SettlementExpense>): SettlementExpense {
  return {
    amountSen: 0,
    category: 'RENT',
    paidBy: 'STALL_FUNDS',
    brandId: null,
    foodAmountSen: 0,
    drinksAmountSen: 0,
    isSettled: true,
    ...overrides,
  }
}

function input(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    orderLines: [line(FOOD, 10_000), line(DRINKS, 5_000)],
    corrections: [],
    // Rent 3,000 shared 70/30, plus a Food-only restock of 1,000.
    expenses: [
      expense({ amountSen: 3_000, foodAmountSen: 2_100, drinksAmountSen: 900 }),
      expense({ amountSen: 1_000, category: 'RAW_MATERIALS', brandId: FOOD, foodAmountSen: 1_000 }),
    ],
    outstandingAdvances: [],
    ledger: [],
    hostCommissionPct: 30,
    foodBrandId: FOOD,
    drinksBrandId: DRINKS,
    openingIouSen: 0,
    ...overrides,
  }
}

describe('settlement on the server', () => {
  it('splits a shared amount without inventing or losing a sen', () => {
    const { foodSen, drinksSen } = splitShared(3_333, 70)
    expect(foodSen + drinksSen).toBe(3_333)
  })

  it('pays Food its result less the host cut, and the host keeps Drinks plus the cut', () => {
    const summary = settlePeriod(input())

    // Food: 10,000 − 1,000 direct − 2,100 overhead = 6,900. Host takes 30%.
    expect(summary.food.netResultSen).toBe(6_900)
    expect(summary.hostCommissionSen).toBe(2_070)
    expect(summary.foodPayoutSen).toBe(4_830)
    // Drinks: 5,000 − 900 overhead = 4,100, plus the 2,070 cut.
    expect(summary.drinksPayoutSen).toBe(6_170)
    expect(summary.transfer).toEqual({ amountSen: 4_830, direction: 'HOST_PAYS_FOOD' })
  })

  it('does not pay the partners on a sale that was refunded to the customer', () => {
    // A 1,200 Food sale was cancelled at the counter. The order row is still there
    // — sales are never edited — so the correction has to be what removes it.
    const withRefund = settlePeriod(
      input({
        orderLines: [line(FOOD, 10_000), line(FOOD, 1_200), line(DRINKS, 5_000)],
        corrections: [{ brandDeltas: [{ brandId: FOOD, deltaSen: -1_200 }] }],
      }),
    )
    expect(withRefund.food.netSalesSen).toBe(10_000)
    expect(withRefund.foodPayoutSen).toBe(settlePeriod(input()).foodPayoutSen)
  })

  it('attributes a cross-brand exchange to both brands', () => {
    const nets = netSalesByBrand(
      [line(FOOD, 1_200)],
      [
        {
          brandDeltas: [
            { brandId: FOOD, deltaSen: -1_200 },
            { brandId: DRINKS, deltaSen: 550 },
          ],
        },
      ],
    )
    expect(nets.get(FOOD)).toBe(0)
    expect(nets.get(DRINKS)).toBe(550)
  })

  it('absorbs a carried deficit once, before the commission, and carries what is left', () => {
    const summary = settlePeriod(input({ openingIouSen: 8_000 }))

    // 6,900 − 8,000 = −1,100: no commission, nothing paid, 1,100 carried on.
    expect(summary.offsetResultSen).toBe(-1_100)
    expect(summary.hostCommissionSen).toBe(0)
    expect(summary.closingIouSen).toBe(1_100)
    expect(summary.foodPayoutSen).toBe(0)
  })

  it('reimburses an advance in full and deducts drawings without flooring them', () => {
    const summary = settlePeriod(
      input({
        outstandingAdvances: [
          expense({ amountSen: 1_000, paidBy: 'PARTNER_DRINKS', isSettled: false }),
        ],
        ledger: [{ category: 'OWNER_DRAWING', brandId: FOOD, amountSen: 6_000 }],
      }),
    )

    expect(summary.drinksAdvancesSen).toBe(1_000)
    expect(summary.drinksPayoutSen).toBe(6_170 + 1_000)
    // Drew 6,000 against a 4,830 share: owes the stall 1,170.
    expect(summary.foodPayoutSen).toBe(-1_170)
    expect(summary.transfer).toEqual({ amountSen: 1_170, direction: 'FOOD_OWES_HOST' })
  })

  it('reads the opening deficit from the latest closure before the period', () => {
    const closures = [
      { endDate: '2026-07-31', closingIouSen: 500 },
      { endDate: '2026-08-31', closingIouSen: 1_100 },
      { endDate: '2026-09-30', closingIouSen: 9_999 },
    ]
    expect(openingDeficitFor(closures, '2026-09-01')).toBe(1_100)
    expect(openingDeficitFor([], '2026-09-01')).toBe(0)
  })
})
