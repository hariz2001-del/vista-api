import { createHash } from 'node:crypto'
import { lineTotalSen } from './domain/expense-items.ts'
import { badRequest } from './errors.ts'
import { expenseBody, type ExpenseBody } from './routes/rms.ts'

export type FormLine = { name: string; quantityMilli: number | null; unitPriceSen: number | null; amountSen: number | null; unit: string | null; category: string | null; brand: string | null; adjustment: boolean }
export type ReceiptForm = { version: number; readingHash: string; paidBy: string | null; paymentMethod: string | null; splitPct: number | null; lines: FormLine[] }
export type FormOptions = { categories: Array<{ value: string; label: string }>; brands: Array<{ id: string; name: string }>; paidBy: Array<{ value: string; label: string }>; paymentMethods: Array<{ value: string; label: string }>; split: { overheadFirstPct: number; equipmentFirstPct: number; firstBrand: string; secondBrand: string } | null }
export type FormReceipt = { id: string; vendor: string | null; receiptNo: string | null; receiptDate: Date | null; totalSen: number | null; extracted: any }
export function readingHash(r: FormReceipt) {
  return createHash('sha256').update(JSON.stringify([r.vendor, r.receiptNo, r.receiptDate, r.totalSen, r.extracted?.lines, r.extracted?.tax_rm, r.extracted?.discount_rm])).digest('hex')
}
const money = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null
export function initialForm(r: FormReceipt, options: FormOptions): ReceiptForm {
  const categories = new Set(options.categories.map(c => c.value))
  const lines: FormLine[] = (Array.isArray(r.extracted?.lines) ? r.extracted.lines.slice(0, 99) : []).map((raw: any) => {
    const quantityMilli = typeof raw.qty === 'number' && raw.qty > 0 ? Math.round(raw.qty * 1000) : null
    const unitPriceSen = money(raw.unit_price_rm), amountSen = money(raw.amount_rm)
    return { name: String(raw.name ?? '').slice(0, 120), quantityMilli, unitPriceSen, amountSen: amountSen ?? (quantityMilli !== null && unitPriceSen !== null ? lineTotalSen(quantityMilli, unitPriceSen) : null), unit: typeof raw.unit === 'string' ? raw.unit.slice(0, 20) : null, category: categories.has(raw.suggested_category) ? raw.suggested_category : null, brand: options.brands.length === 1 ? options.brands[0]!.id : null, adjustment: false }
  })
  if (lines.length && r.totalSen !== null && lines.every(l => l.amountSen !== null)) {
    const difference = r.totalSen - lines.reduce((sum, l) => sum + l.amountSen!, 0)
    if (difference) lines.push({ name: 'Difference to printed total (tax / discount / rounding)', quantityMilli: 1000, unitPriceSen: difference, amountSen: difference, unit: null, category: null, brand: options.brands.length === 1 ? options.brands[0]!.id : null, adjustment: true })
  }
  const payment = String(r.extracted?.payment ?? '').toLowerCase()
  const paymentMethod = /\bcash\b/.test(payment) && !/\b(card|visa|master|qr)\b/.test(payment) && options.paymentMethods.some(m => m.value === 'CASH') ? 'CASH' : null
  return { version: 0, readingHash: readingHash(r), paidBy: options.paidBy[0]?.value ?? null, paymentMethod, splitPct: null, lines }
}
export function formEntries(form: ReceiptForm, r: FormReceipt, options: FormOptions): ExpenseBody[] {
  const fail = (message: string): never => { throw badRequest('agent:FORM_INCOMPLETE', message) }
  if (!r.receiptDate || r.totalSen === null) fail('Review the receipt date and total before saving.')
  if (!form.lines.length) fail('Receipt parsing is not complete. Review the reading before categorising.')
  if (!options.paidBy.some(p => p.value === form.paidBy)) fail('Choose a current Vista funding option.')
  if (form.paymentMethod !== null && !options.paymentMethods.some(p => p.value === form.paymentMethod)) fail('Choose a current Vista payment method.')
  const groups = new Map<string, FormLine[]>()
  for (const [i, line] of form.lines.entries()) {
    if (!options.categories.some(c => c.value === line.category)) fail(`Choose a category for line ${i + 1}.`)
    if (line.brand !== 'SHARED' && !options.brands.some(b => b.id === line.brand)) fail(`Choose a brand for line ${i + 1}.`)
    if (line.brand === 'SHARED' && !options.split) fail('Shared allocation is not enabled in this business.')
    if (!line.name || line.quantityMilli === null || line.unitPriceSen === null || line.amountSen === null) fail(`Review quantity, price and amount for line ${i + 1}. Missing values are not guessed.`)
    if (lineTotalSen(line.quantityMilli!, line.unitPriceSen!) !== line.amountSen) fail(`Line ${i + 1} quantity × unit price differs from its amount. Edit the reading first.`)
    const key = `${line.category}:${line.brand}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  if (groups.size > 10) fail('This receipt has more than ten category/brand groups. Ask Hermes to split the posting into reviewed allocations.')
  const entries = [...groups.values()].map(lines => {
    const first = lines[0]!, amountSen = lines.reduce((sum, l) => sum + l.amountSen!, 0)
    if (amountSen <= 0) fail('Assign discounts/rounding to the same category and brand as a positive purchase; an expense group must have a positive total.')
    return expenseBody.parse({ businessDate: r.receiptDate!.toISOString().slice(0, 10), amountSen, category: first.category, brandId: first.brand === 'SHARED' ? null : first.brand, paidBy: form.paidBy, paymentMethod: form.paymentMethod, foodSplitPct: first.brand === 'SHARED' ? form.splitPct ?? (first.category === 'CAPITAL_ASSET' ? options.split!.equipmentFirstPct : options.split!.overheadFirstPct) : 100, description: lines.map(l => l.name).join('; ').slice(0, 200), vendor: r.vendor, receiptNo: r.receiptNo, notes: `Receipt R-${r.id.slice(0, 6).toUpperCase()}; Telegram categorisation`, items: lines.map(l => ({ name: l.name, quantityMilli: l.quantityMilli, unitPriceSen: l.unitPriceSen, unit: l.unit })) })
  })
  if (entries.reduce((sum, e) => sum + e.amountSen, 0) !== r.totalSen) fail('Configured entries do not reconcile to the printed receipt total. Review the reading.')
  return entries
}
