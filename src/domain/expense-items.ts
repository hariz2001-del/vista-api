/**
 * Receipt lines in integer money. A quantity is carried in thousandths of a
 * unit (2.5 kg = 2500), so a line's total is an integer product divided once,
 * rounded half away from zero — never a float. The RMS computes the same thing
 * with the same rule, and the API recomputes it rather than trusting the form.
 */

export type ExpenseItemInput = {
  name: string
  quantityMilli: number
  unit: string | null
  unitPriceSen: number
}

export function lineTotalSen(quantityMilli: number, unitPriceSen: number): number {
  const product = quantityMilli * unitPriceSen
  if (!Number.isSafeInteger(product)) throw new Error('line total out of range')
  const magnitude = Math.floor((Math.abs(product) + 500) / 1000)
  return product < 0 ? -magnitude : magnitude
}

export function itemsTotalSen(items: readonly ExpenseItemInput[]): number {
  return items.reduce((sum, item) => sum + lineTotalSen(item.quantityMilli, item.unitPriceSen), 0)
}
