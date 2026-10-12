import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { requireAgent } from '../auth.ts'
import { DomainError, conflict, notFound } from '../errors.ts'
import { formEntries, initialForm, readingHash, type FormOptions, type ReceiptForm } from '../receipt-form.ts'
import type { Tx } from '../db.ts'
import { expenseBody } from './rms.ts'

const ID = z.string().uuid()
const guard = { preHandler: requireAgent('BOOKKEEPER') }
const fieldMap = { merchant: 'Expense.vendor', invoice: 'Expense.receiptNo (supplier invoice, not internal ID)', date: 'Expense.businessDate', funding: 'Expense.paidBy', method: 'Expense.paymentMethod', category: 'Expense.category', brand: 'Expense.brandId', split: 'Expense.foodSplitPct; allocated amount snapshots via RMS rules', lines: 'ExpenseItem.name / quantityMilli / unit / unitPriceSen / totalSen', receipt: 'Expense.receiptDocumentId → ReceiptDocument → original/scan Drive IDs' }
const json = (v: unknown) => JSON.parse(JSON.stringify(v))
export async function agentReceiptFormRoutes(app: FastifyInstance) {
  async function invoke(request: FastifyRequest, method: 'GET' | 'POST', path: string, payload?: object) {
    const reply = await app.inject({ method, url: path, headers: { authorization: request.headers.authorization!, 'x-telegram-user': String(request.headers['x-telegram-user']) }, payload })
    const result = reply.json()
    if (reply.statusCode >= 400) throw new DomainError(result.error, reply.statusCode, result.message ?? 'Receipt action failed.')
    return result
  }
  const options = async (request: FastifyRequest): Promise<FormOptions> => invoke(request, 'GET', '/agent/options')
  async function load(db: Tx, request: FastifyRequest, id: string, choices: FormOptions) {
    const receipt = await db.receiptDocument.findUnique({ where: { id }, include: { expenses: { select: { id: true, brandId: true, amountSen: true, description: true } }, image: { select: { receiptId: true } } } })
    if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
    const stored = (receipt.extracted as any)?._entryForms?.[request.agentUser!.id] as ReceiptForm | undefined
    const form = stored?.readingHash === readingHash(receipt) ? stored : initialForm(receipt, choices)
    return { receipt, form, reset: Boolean(stored && stored.readingHash !== form.readingHash) }
  }
  async function view(request: FastifyRequest, id: string) {
    const choices = await options(request)
    const { receipt, form, reset } = await load(request.db, request, id, choices)
    const matches = (await invoke(request, 'GET', `/agent/receipts/${id}/matches`)).matches
    const duplicates = (await invoke(request, 'GET', `/agent/receipts/${id}/duplicates`)).candidates
    return { receipt: { id, ref: `R-${id.slice(0, 6).toUpperCase()}`, vendor: receipt.vendor, date: receipt.receiptDate?.toISOString().slice(0, 10) ?? null, receiptNo: receipt.receiptNo, totalSen: receipt.totalSen, status: receipt.status, hasScan: Boolean(receipt.scanDriveFileId || (receipt.extracted as any)?.scan), photoAttached: Boolean(receipt.driveFileId || receipt.image), reviewFlags: receipt.reviewFlags, expenses: receipt.expenses }, form, options: choices, readingChanged: reset, readOnly: ['POSTED', 'LINKED', 'REJECTED'].includes(receipt.status), matches, duplicates, fieldMap }
  }
  app.get<{ Params: { id: string } }>('/agent/receipts/:id/form', guard, request => view(request, ID.parse(request.params.id)))
  app.patch<{ Params: { id: string } }>('/agent/receipts/:id/form', guard, async request => {
    const id = ID.parse(request.params.id)
    const body = z.object({ version: z.number().int().min(0), field: z.enum(['category', 'brand', 'funding', 'method', 'split']), value: z.union([z.string(), z.number(), z.null()]), lineIndex: z.number().int().min(0).max(99).optional() }).parse(request.body)
    const choices = await options(request)
    await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const { receipt, form } = await load(tx, request, id, choices)
      if (['POSTED', 'LINKED', 'REJECTED'].includes(receipt.status)) throw conflict('agent:RECEIPT_DONE')
      if (body.version !== form.version) throw conflict('agent:FORM_STALE', 'This form changed. Reopen Categorise and review the current receipt.')
      if (body.field === 'category' || body.field === 'brand') {
        const allowed = body.field === 'category' ? choices.categories.map(c => c.value) : [...choices.brands.map(b => b.id), ...(choices.split ? ['SHARED'] : [])]
        if (typeof body.value !== 'string' || !allowed.includes(body.value)) throw conflict('agent:FORM_OPTION_CHANGED')
        if (body.lineIndex !== undefined && !form.lines[body.lineIndex]) throw notFound('agent:LINE_NOT_FOUND')
        const target = body.lineIndex === undefined ? form.lines : [form.lines[body.lineIndex]!]
        for (const line of target) line[body.field] = body.value
      } else if (body.field === 'funding') {
        if (!choices.paidBy.some(p => p.value === body.value)) throw conflict('agent:FORM_OPTION_CHANGED')
        form.paidBy = body.value as string
      } else if (body.field === 'method') {
        if (body.value !== null && !choices.paymentMethods.some(p => p.value === body.value)) throw conflict('agent:FORM_OPTION_CHANGED')
        form.paymentMethod = body.value as string | null
      } else {
        if (!choices.split || body.value !== null && (typeof body.value !== 'number' || !Number.isInteger(body.value) || body.value < 0 || body.value > 100)) throw conflict('agent:FORM_OPTION_CHANGED')
        form.splitPct = body.value as number | null
      }
      form.version++
      const extracted = receipt.extracted as any ?? {}
      await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...extracted, _entryForms: { ...extracted._entryForms, [request.agentUser!.id]: form } }) } })
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.form.updated', entityType: 'receipt', entityId: id, detail: body } })
    })
    return view(request, id)
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/preview', guard, async request => {
    const id = ID.parse(request.params.id), choices = await options(request)
    const { receipt, form } = await load(request.db, request, id, choices)
    if (['POSTED', 'LINKED', 'REJECTED'].includes(receipt.status)) throw conflict('agent:RECEIPT_DONE')
    const entries = formEntries(form, receipt, choices)
    const preview = await invoke(request, 'POST', `/agent/receipts/${id}/preview`, { entries })
    const confirmation = await request.db.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.form.previewed', entityType: 'receipt', entityId: id, detail: json({ entries, previewToken: preview.previewToken, version: form.version, readingHash: form.readingHash, choices }) } })
    return { ...preview, confirmationId: confirmation.id.toString(), fieldMap, matches: (await invoke(request, 'GET', `/agent/receipts/${id}/matches`)).matches }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/post', guard, async request => {
    const id = ID.parse(request.params.id), body = z.object({ confirmationId: z.string().regex(/^\d{1,19}$/).refine(v => BigInt(v) <= 9223372036854775807n) }).parse(request.body)
    const action = await request.db.agentAction.findFirst({ where: { id: BigInt(body.confirmationId), agentUserId: request.agentUser!.id, entityId: id, action: 'receipt.form.previewed' } })
    if (!action) throw notFound('agent:PREVIEW_NOT_FOUND')
    const saved = action.detail as any, choices = await options(request)
    const { form } = await load(request.db, request, id, choices)
    if (form.version !== saved.version || form.readingHash !== saved.readingHash || !isDeepStrictEqual(choices, saved.choices)) throw conflict('agent:FORM_STALE', 'The receipt or Vista settings changed. Review and preview again.')
    // Postgres JSONB reorders keys; restore the shared schema's canonical shape.
    return invoke(request, 'POST', `/agent/receipts/${id}/post`, { entries: saved.entries.map((e: unknown) => expenseBody.parse(e)), previewToken: saved.previewToken })
  })
}
