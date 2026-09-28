import { describe, expect, it } from 'vitest'
import { itemsTotalSen, lineTotalSen } from './expense-items.ts'

describe('lineTotalSen', () => {
  it('multiplies whole units exactly', () => {
    expect(lineTotalSen(10_000, 850)).toBe(8_500) // 10 ekor × RM 8.50
  })

  it('handles fractional quantities without floats', () => {
    expect(lineTotalSen(2_500, 1_290)).toBe(3_225) // 2.5 kg × RM 12.90
    expect(lineTotalSen(1_333, 100)).toBe(133) // 1.333 × RM 1.00 = 133.3 sen
  })

  it('rounds half away from zero', () => {
    expect(lineTotalSen(1_500, 1)).toBe(2) // 1.5 sen
    expect(lineTotalSen(1_000, -2)).toBe(-2)
    expect(lineTotalSen(1_500, -1)).toBe(-2) // −1.5 sen
  })

  it('sums lines, including a negative rounding line', () => {
    expect(
      itemsTotalSen([
        { name: 'Ayam', quantityMilli: 3_000, unit: 'kg', unitPriceSen: 1_290 },
        { name: 'Telur', quantityMilli: 1_000, unit: 'papan', unitPriceSen: 1_152 },
        { name: 'Rounding', quantityMilli: 1_000, unit: null, unitPriceSen: -2 },
      ]),
    ).toBe(5_020)
  })
})
