import { apportion, assertSen } from './money.ts'

/**
 * Server-side pricing. Everything here is computed from catalogue values the
 * caller has already looked up in the database — the client's own prices are
 * recorded as a snapshot and never used to reach a total.
 */

export type PricedLineInput = {
  brandId: string
  /** From `products.base_price_sen`, never from the request. */
  unitPriceSen: number
  /** Sum of the selected `modifier_items.price_sen`, never from the request. */
  modifierTotalSen: number
  quantity: number
  /** What the cashier asked for on this line. Capped below at the line's gross. */
  requestedLineDiscountSen: number
}

export type PricedLine = {
  brandId: string
  grossSen: number
  lineDiscountSen: number
  allocatedOrderDiscountSen: number
  netSen: number
}

export type PricedOrder = {
  lines: PricedLine[]
  grossSen: number
  lineDiscountSen: number
  orderDiscountSen: number
  totalAmountSen: number
}

/**
 * Price an order and attribute every sen of discount to a line.
 *
 * The order-wide discount is apportioned in **two passes**, and the order
 * matters. It is split across brands first, then across the lines within each
 * brand.
 *
 * Doing it in one pass across all lines would be simpler and would still sum
 * correctly — but summing those per-line shares back up by brand can land a sen
 * away from what the POS displayed, because the POS apportions at brand level
 * ([pos-vista/src/domain/cart.ts](../../../pos-vista/src/domain/cart.ts)). Brand
 * totals feed the partner settlement, so the two must agree exactly. Splitting
 * by brand first makes them agree by construction rather than by luck.
 */
export function priceOrder(
  lines: readonly PricedLineInput[],
  requestedOrderDiscountSen: number,
): PricedOrder {
  assertSen(requestedOrderDiscountSen, 'order discount')

  const gross = lines.map((line) => {
    assertSen(line.unitPriceSen, 'unit price')
    assertSen(line.modifierTotalSen, 'modifier total')
    assertSen(line.quantity, 'quantity')
    assertSen(line.requestedLineDiscountSen, 'line discount')
    return (line.unitPriceSen + line.modifierTotalSen) * line.quantity
  })

  const lineDiscounts = lines.map((line, index) =>
    Math.min(line.requestedLineDiscountSen, gross[index] ?? 0),
  )

  // What is left on each line for an order-wide discount to come off.
  const bases = gross.map((value, index) => value - (lineDiscounts[index] ?? 0))
  const totalBaseSen = bases.reduce((sum, base) => sum + base, 0)
  const orderDiscountSen = Math.min(requestedOrderDiscountSen, totalBaseSen)

  // Pass one: across brands, in first-seen order.
  const brandOrder: string[] = []
  const brandBase = new Map<string, number>()
  lines.forEach((line, index) => {
    if (!brandBase.has(line.brandId)) brandOrder.push(line.brandId)
    brandBase.set(line.brandId, (brandBase.get(line.brandId) ?? 0) + (bases[index] ?? 0))
  })
  const brandShares = apportion(
    orderDiscountSen,
    brandOrder.map((brandId) => brandBase.get(brandId) ?? 0),
  )

  // Pass two: within each brand, across that brand's own lines.
  const allocated: number[] = Array.from({ length: lines.length }, () => 0)
  brandOrder.forEach((brandId, brandIndex) => {
    const indices = lines
      .map((line, index) => (line.brandId === brandId ? index : -1))
      .filter((index) => index >= 0)
    const shares = apportion(
      brandShares[brandIndex] ?? 0,
      indices.map((index) => bases[index] ?? 0),
    )
    indices.forEach((lineIndex, position) => {
      allocated[lineIndex] = shares[position] ?? 0
    })
  })

  const priced: PricedLine[] = lines.map((line, index) => {
    const grossSen = gross[index] ?? 0
    const lineDiscountSen = lineDiscounts[index] ?? 0
    const allocatedOrderDiscountSen = allocated[index] ?? 0
    return {
      brandId: line.brandId,
      grossSen,
      lineDiscountSen,
      allocatedOrderDiscountSen,
      netSen: grossSen - lineDiscountSen - allocatedOrderDiscountSen,
    }
  })

  const grossSen = gross.reduce((sum, value) => sum + value, 0)
  const lineDiscountSen = lineDiscounts.reduce((sum, value) => sum + value, 0)

  return {
    lines: priced,
    grossSen,
    lineDiscountSen,
    orderDiscountSen,
    totalAmountSen: grossSen - lineDiscountSen - orderDiscountSen,
  }
}

/** Net sales per brand, which is what the partner settlement is built on. */
export function netByBrand(order: PricedOrder): Map<string, number> {
  const totals = new Map<string, number>()
  for (const line of order.lines) {
    totals.set(line.brandId, (totals.get(line.brandId) ?? 0) + line.netSen)
  }
  return totals
}
