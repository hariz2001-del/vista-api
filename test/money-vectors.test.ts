import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { netByBrand, priceOrder, type PricedLineInput } from '../src/domain/cart.ts'

type VectorLine = {
  brandId: string
  unitPriceSen: number
  modifierTotalSen: number
  quantity: number
  lineDiscountSen: number
}

type VectorBrand = {
  brandId: string
  grossSen: number
  lineDiscountSen: number
  cartDiscountSen: number
  netSen: number
}

type Vector = {
  name: string
  orderDiscountSen: number
  lines: VectorLine[]
  expect: {
    grossSen: number
    lineDiscountSen: number
    orderDiscountSen: number
    totalAmountSen: number
    brands: VectorBrand[]
  }
}

const vectorsPath = fileURLToPath(new URL('../../money-vectors.json', import.meta.url))
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { cases: Vector[] }

function toInput(line: VectorLine): PricedLineInput {
  return {
    brandId: line.brandId,
    unitPriceSen: line.unitPriceSen,
    modifierTotalSen: line.modifierTotalSen,
    quantity: line.quantity,
    requestedLineDiscountSen: line.lineDiscountSen,
  }
}

describe('money vectors — shared with pos-vista', () => {
  it('loaded some cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(5)
  })

  for (const testCase of vectors.cases) {
    it(testCase.name, () => {
      const priced = priceOrder(testCase.lines.map(toInput), testCase.orderDiscountSen)

      expect(priced.grossSen).toBe(testCase.expect.grossSen)
      expect(priced.lineDiscountSen).toBe(testCase.expect.lineDiscountSen)
      expect(priced.orderDiscountSen).toBe(testCase.expect.orderDiscountSen)
      expect(priced.totalAmountSen).toBe(testCase.expect.totalAmountSen)

      // Per-brand attribution is what the partner settlement is built on.
      for (const expectedBrand of testCase.expect.brands) {
        const lines = priced.lines.filter((line) => line.brandId === expectedBrand.brandId)
        const sum = (pick: (line: (typeof lines)[number]) => number) =>
          lines.reduce((total, line) => total + pick(line), 0)

        expect(sum((line) => line.grossSen)).toBe(expectedBrand.grossSen)
        expect(sum((line) => line.lineDiscountSen)).toBe(expectedBrand.lineDiscountSen)
        expect(sum((line) => line.allocatedOrderDiscountSen)).toBe(expectedBrand.cartDiscountSen)
        expect(sum((line) => line.netSen)).toBe(expectedBrand.netSen)
      }

      // Invariants that must hold for every case, stated in the fixture header.
      const brands = netByBrand(priced)
      expect([...brands.values()].reduce((a, b) => a + b, 0)).toBe(testCase.expect.totalAmountSen)
      expect(
        priced.lines.reduce((total, line) => total + line.allocatedOrderDiscountSen, 0),
      ).toBe(priced.orderDiscountSen)
      expect(priced.lines.every((line) => line.netSen >= 0)).toBe(true)
      expect(priced.grossSen - priced.lineDiscountSen - priced.orderDiscountSen).toBe(
        priced.totalAmountSen,
      )
    })
  }
})
