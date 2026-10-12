import type { Tx } from './db.ts'
import type { FormOptions, ReceiptForm } from './receipt-form.ts'
export const itemKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
/** Suggestions use confirmed, business-scoped expenses, never chat/OCR guesses. */
export async function suggestReceiptLines(db: Tx, form: ReceiptForm, options: FormOptions) {
  const history = await db.expenseItem.findMany({ orderBy: [{ expense: { createdAt: 'desc' } }, { sortOrder: 'asc' }], take: 3000, include: { expense: { select: { id: true, brandId: true, category: true, createdAt: true } } } })
  const suggestions: Array<{ index: number; source: string; examples: number; confidence: number }> = []
  for (const [index, line] of form.lines.entries()) {
    if (line.adjustment) continue
    const examples = history.filter(h => itemKey(h.name) === itemKey(line.name)).toSorted((a,b) => b.expense.createdAt.getTime()-a.expense.createdAt.getTime())
    const unique = [...new Map(examples.map(h => [h.expense.id, h])).values()].slice(0, 12)
    if (!unique.length) continue
    const groups = new Map<string, typeof unique>()
    for (const h of unique) { const key = `${h.expense.category}:${h.expense.brandId ?? 'SHARED'}`; groups.set(key, [...(groups.get(key) ?? []), h]) }
    const best = [...groups.values()].toSorted((a,b) => b.length-a.length)[0]!, confidence = best.length / unique.length, brand = best[0]!.expense.brandId ?? 'SHARED'
    if (confidence < 0.8 || !options.categories.some(c => c.value === best[0]!.expense.category) || !(brand === 'SHARED' ? options.split : options.brands.some(b => b.id === brand))) continue
    line.category = best[0]!.expense.category; line.brand = brand
    suggestions.push({ index, source: 'confirmed Vista entries', examples: best.length, confidence })
  }
  const real = form.lines.filter(l => !l.adjustment)
  if (real.length && real.every(line => line.brand === real[0]!.brand && line.category === real[0]!.category)) for (const line of form.lines.filter(item => item.adjustment)) { line.brand = real[0]!.brand; line.category = real[0]!.category }
  return suggestions
}
