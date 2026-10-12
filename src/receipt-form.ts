import { createHash } from 'node:crypto'
import { lineTotalSen } from './domain/expense-items.ts'
import { DomainError, conflict } from './errors.ts'
import { expenseBody, type ExpenseBody } from './routes/rms.ts'

export type FormLine = { name: string; quantityMilli: number | null; unitPriceSen: number | null; amountSen: number | null; unit: string | null; category: string | null; brand: string | null; adjustment: boolean; custom?: boolean }
export type ReceiptForm = { version: number; readingHash: string; paidBy: string | null; paymentMethod: string | null; splitPct: number | null; lines: FormLine[]; selectedIndices?: number[]; ledgerVersion?: number; stage?: 'configure' | 'select' | 'remaining' }
export type LineDecision = { state: 'pending' | 'posted' | 'scrapped'; brand?: string | null; category?: string | null; expenseId?: string; actorId?: string }
export type LineWorkflow = { version: number; readingHash: string; decisions: LineDecision[]; annotation?: { id: string; url: string; version: number; positioned?: number }; regions?: Array<{ index: number; x: number; y: number; width: number; height: number }>; annotationLease?: { token: string; until: number }; annotationError?: string }
export type FormOptions = { categories: Array<{ value: string; label: string }>; brands: Array<{ id: string; name: string }>; paidBy: Array<{ value: string; label: string }>; paymentMethods: Array<{ value: string; label: string }>; split: { overheadFirstPct: number; equipmentFirstPct: number; firstBrand: string; secondBrand: string } | null }
export type FormReceipt = { id: string; vendor: string | null; receiptNo: string | null; receiptDate: Date | null; totalSen: number | null; extracted: any }
export function readingHash(r: FormReceipt) {
  const fields = [r.vendor, r.receiptNo, r.receiptDate, r.totalSen, r.extracted?.lines, r.extracted?.tax_rm, r.extracted?.discount_rm]
  if (r.extracted?.document_type === 'bank_screenshot') fields.push(r.extracted.document_type,r.extracted.transaction_direction,r.extracted.purpose)
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}
const money = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null
export function lineWorkflow(r: FormReceipt, count: number): LineWorkflow {
  const stored = r.extracted?._lineWorkflow as LineWorkflow | undefined
  if (stored?.readingHash === readingHash(r)) return stored
  if (stored?.decisions.some(d => d.state !== 'pending')) throw conflict('agent:READING_ALLOCATED', 'This reading already has allocated/excluded items. Do not reorder or rewrite it.')
  return { version: 0, readingHash: readingHash(r), decisions: Array.from({ length: count }, () => ({ state: 'pending' })) }
}
export const selectedIndices = (form: ReceiptForm) => form.selectedIndices ?? form.lines.map((_, i) => i)
export function initialForm(r: FormReceipt, options: FormOptions): ReceiptForm {
  const categories = new Set(options.categories.map(c => c.value))
  const lines: FormLine[] = (Array.isArray(r.extracted?.lines) ? r.extracted.lines.slice(0, 99) : []).map((raw: any) => {
    const quantityMilli = typeof raw.qty === 'number' && raw.qty > 0 ? Math.round(raw.qty * 1000) : null
    const unitPriceSen = money(raw.unit_price_rm), amountSen = money(raw.amount_rm)
    return { name: String(raw.name ?? '').slice(0, 120), quantityMilli, unitPriceSen, amountSen: amountSen ?? (quantityMilli !== null && unitPriceSen !== null ? lineTotalSen(quantityMilli, unitPriceSen) : null), unit: typeof raw.unit === 'string' ? raw.unit.slice(0, 20) : null, category: categories.has(raw.suggested_category) ? raw.suggested_category : categories.has('RAW_MATERIALS') ? 'RAW_MATERIALS' : null, brand: options.brands[0]?.id ?? null, adjustment: false }
  })
  if (!lines.length && r.extracted?.document_type === 'bank_screenshot' && r.totalSen !== null) lines.push({ name: String(r.extracted?.purpose ?? 'Bank transaction — edit purpose before saving').slice(0,120), quantityMilli:1000, unitPriceSen:r.totalSen,amountSen:r.totalSen,unit:null,category:categories.has('RAW_MATERIALS')?'RAW_MATERIALS':null,brand:options.brands[0]?.id??null,adjustment:false,custom:true })
  if (lines.length && r.totalSen !== null && lines.every(l => l.amountSen !== null)) {
    const difference = r.totalSen - lines.reduce((sum, l) => sum + l.amountSen!, 0)
    if (difference) lines.push({ name: 'Difference to printed total (tax / discount / rounding)', quantityMilli: 1000, unitPriceSen: difference, amountSen: difference, unit: null, category: categories.has('RAW_MATERIALS') ? 'RAW_MATERIALS' : null, brand: options.brands[0]?.id ?? null, adjustment: true })
  }
  const payment = String(r.extracted?.payment ?? '').toLowerCase()
  const paymentMethod = /\bcash\b/.test(payment) && !/\b(card|visa|master|qr)\b/.test(payment) && options.paymentMethods.some(m => m.value === 'CASH') ? 'CASH' : null
  const ledger = lineWorkflow(r, lines.length), pending = ledger.decisions.flatMap((d, i) => d.state === 'pending' ? [i] : [])
  const previous = r.extracted?._entryDefaults
  const fundingDefault = options.paidBy.find(p => p.value === 'STALL_FUNDS')?.value ?? options.paidBy[0]?.value ?? null
  return { version: 0, readingHash: readingHash(r), paidBy: options.paidBy.some(p => p.value === previous?.paidBy) ? previous.paidBy : fundingDefault, paymentMethod: previous && (previous.paymentMethod === null || options.paymentMethods.some(m => m.value === previous.paymentMethod)) ? previous.paymentMethod : paymentMethod, splitPct: null, lines, selectedIndices: pending, ledgerVersion: ledger.version, stage: ledger.decisions.some(d => d.state !== 'pending') ? 'remaining' : 'configure' }
}
export function formEntries(form: ReceiptForm, r: FormReceipt, options: FormOptions): ExpenseBody[] {
  // These are reviewed user-facing validation messages, safe in production.
  const fail = (message: string): never => { throw new DomainError('agent:FORM_INCOMPLETE', 400, message) }
  if(r.extracted?._allocationCorrection)fail('A booked allocation was corrected. Review existing entries in Vista before booking more items from this original receipt.')
  if (r.extracted?.document_type === 'bank_screenshot' && r.extracted?.transaction_direction !== 'outgoing') fail('Confirm whether this bank transfer is an outgoing expense. Incoming money/internal transfers must use the appropriate Vista cashflow, not a new expense.')
  if (form.lines.some(l => l.custom && !r.extracted?.purpose)) fail('Edit the bank transaction purpose before saving. No purchased goods are inferred from a screenshot.')
  if (!r.receiptDate || r.totalSen === null) fail('Review the receipt date and total before saving.')
  if (!form.lines.length) fail('Receipt parsing is not complete. Review the reading before categorising.')
  const selected = selectedIndices(form)
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(i => !form.lines[i])) fail('Choose the receipt items to book first.')
  const ledger = lineWorkflow(r, form.lines.length)
  if (selected.some(i => ledger.decisions[i]?.state !== 'pending')) fail('An item was already saved or scrapped. Reopen the remaining items.')
  if (!options.paidBy.some(p => p.value === form.paidBy)) fail('Choose a current Vista funding option.')
  if (form.paymentMethod !== null && !options.paymentMethods.some(p => p.value === form.paymentMethod)) fail('Choose a current Vista payment method.')
  const groups = new Map<string, FormLine[]>()
  for (const i of selected) {
    const line = form.lines[i]!
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
  if (form.lines.every(l => l.amountSen !== null) && form.lines.reduce((sum, l) => sum + l.amountSen!, 0) !== r.totalSen) fail('The reading does not reconcile to the printed receipt total. Review the reading.')
  const disposed = form.lines.reduce((sum, l, i) => sum + (ledger.decisions[i]?.state !== 'pending' ? l.amountSen ?? 0 : 0), 0)
  if (entries.reduce((sum, e) => sum + e.amountSen, 0) > r.totalSen! - disposed) fail('Include the receipt discount/rounding in this group; its amount exceeds the remaining receipt total.')
  return entries
}
