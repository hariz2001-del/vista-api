/**
 * Closing stock levels, notes and grouping, as the RMS shows them. Kept the
 * same as rms-vista/src/domain/stock.ts so the server's PDF reads like the
 * screen: change both together.
 */

export type StockBalance =
  | 'EMPTY'
  | 'QUARTER'
  | 'HALF'
  | 'THREE_QUARTERS'
  | 'FULL'
  // The old three-step scale, on counts sent before the five-step bar.
  | 'MORE_THAN_HALF'
  | 'LESS_THAN_HALF'

export type StockLevel = {
  value: StockBalance
  /** How full, 0–100: the width of the bar. */
  pct: number
  label: string
  /** The bar's colour at this level: red when finished, through to green when full. */
  colour: string
}

/** The five steps on the bar, emptiest first. */
export const LEVELS: StockLevel[] = [
  { value: 'EMPTY', pct: 0, label: '0%', colour: '#dc2626' },
  { value: 'QUARTER', pct: 25, label: '25%', colour: '#ea580c' },
  { value: 'HALF', pct: 50, label: '50%', colour: '#eab308' },
  { value: 'THREE_QUARTERS', pct: 75, label: '75%', colour: '#84cc16' },
  { value: 'FULL', pct: 100, label: '100%', colour: '#16a34a' },
]

/** Any balance as a level to draw. The old scale shows at its nearest step, under its old name. */
export function levelOf(balance: StockBalance | null | undefined): StockLevel | null {
  if (!balance) return null
  if (balance === 'MORE_THAN_HALF') return { ...LEVELS[3]!, value: balance, label: '> ½' }
  if (balance === 'LESS_THAN_HALF') return { ...LEVELS[1]!, value: balance, label: '< ½' }
  return LEVELS.find((level) => level.value === balance) ?? null
}

export type StockNote = { text: string; colour: string }

type NoteLine = {
  trackUnopened: boolean
  trackOpened: boolean
  trackBalance: boolean
  unopenedMilli: number | null
  openedMilli: number | null
  balance: StockBalance | null
}

/**
 * What to say at the end of a line. The bar is the opened one only, so an item
 * is finished, or low, only when no unopened stock is left as well: an empty
 * open bottle with sealed ones on the shelf is neither.
 */
export function stockNote(line: NoteLine): StockNote | null {
  const noneSealed = !line.trackUnopened || line.unopenedMilli === 0
  if (!noneSealed) return null
  if (line.trackBalance) {
    if (line.balance === 'EMPTY') return { text: 'Finished stock', colour: LEVELS[0]!.colour }
    if (line.balance === 'QUARTER') return { text: 'Low stock', colour: LEVELS[1]!.colour }
    return null
  }
  // No bar to read: nothing unopened, and nothing opened where that is counted.
  if (line.trackUnopened && (!line.trackOpened || line.openedMilli === 0)) {
    return { text: 'Finished stock', colour: LEVELS[0]!.colour }
  }
  return null
}

export type Groupable = {
  brandKey: string
  category: string
  subcategory: string | null
}

export type SubcategoryGroup<T> = { subcategory: string | null; items: T[] }
export type CategoryGroup<T> = { category: string; subcategories: Array<SubcategoryGroup<T>> }
export type BrandGroup<T> = { brandKey: string; categories: Array<CategoryGroup<T>> }

export function groupStock<T extends Groupable>(rows: readonly T[]): Array<BrandGroup<T>> {
  const brands: Array<BrandGroup<T>> = []
  for (const row of rows) {
    let brand = brands.find((group) => group.brandKey === row.brandKey)
    if (!brand) {
      brand = { brandKey: row.brandKey, categories: [] }
      brands.push(brand)
    }
    let category = brand.categories.find((group) => group.category === row.category)
    if (!category) {
      category = { category: row.category, subcategories: [] }
      brand.categories.push(category)
    }
    let subcategory = category.subcategories.find((group) => group.subcategory === row.subcategory)
    if (!subcategory) {
      subcategory = { subcategory: row.subcategory, items: [] }
      category.subcategories.push(subcategory)
    }
    subcategory.items.push(row)
  }
  return brands
}

/** 2500 → "2.5", 0 → "0". */
export function formatCount(milli: number): string {
  const whole = Math.trunc(milli / 1000)
  const fraction = (milli % 1000).toString().padStart(3, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}
