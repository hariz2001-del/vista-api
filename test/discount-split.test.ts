import { describe, expect, it } from 'vitest'
import { netByBrand, priceOrder } from '../src/domain/cart.ts'

/**
 * How a discount lands on each brand — which is what partner settlement pays
 * on. An order-wide discount (typed in, or a whole-order promo) is split
 * between brands by each brand's share of the order. A discount on one item
 * comes off that item's brand alone.
 */

const FOOD = 'food'
const DRINKS = 'drinks'
const line = (brandId: string, unitPriceSen: number, requestedLineDiscountSen = 0) => ({
  brandId,
  unitPriceSen,
  modifierTotalSen: 0,
  quantity: 1,
  requestedLineDiscountSen,
})

describe('discounts between brands', () => {
  it('splits an order discount by each brand’s share of the order', () => {
    // RM 12 Food + RM 8 Drinks = 60/40. RM 2 off → RM 1.20 and RM 0.80.
    const priced = priceOrder([line(FOOD, 1200), line(DRINKS, 800)], 200)
    const net = netByBrand(priced)
    expect(net.get(FOOD)).toBe(1200 - 120)
    expect(net.get(DRINKS)).toBe(800 - 80)
    expect(priced.totalAmountSen).toBe(1800)
  })

  it('works a 10% whole-order promo out the same way', () => {
    // A promo only fills in the amount: 10% of RM 25.00 is RM 2.50.
    const priced = priceOrder([line(FOOD, 1500), line(DRINKS, 1000)], 250)
    const net = netByBrand(priced)
    expect(net.get(FOOD)).toBe(1500 - 150)
    expect(net.get(DRINKS)).toBe(1000 - 100)
  })

  it('takes an item discount off that item’s brand only', () => {
    const priced = priceOrder([line(FOOD, 1200, 300), line(DRINKS, 800)], 0)
    const net = netByBrand(priced)
    expect(net.get(FOOD)).toBe(900)
    expect(net.get(DRINKS)).toBe(800)
  })

  it('splits by what is left after item discounts, and never loses a sen', () => {
    // Food RM 10 less RM 4 item discount = RM 6; Drinks RM 3. RM 1 off the order → 2/3 and 1/3.
    const priced = priceOrder([line(FOOD, 1000, 400), line(DRINKS, 300)], 100)
    const net = netByBrand(priced)
    expect(net.get(FOOD)).toBe(600 - 67)
    expect(net.get(DRINKS)).toBe(300 - 33)
    expect((net.get(FOOD) ?? 0) + (net.get(DRINKS) ?? 0)).toBe(priced.totalAmountSen)
  })
})
