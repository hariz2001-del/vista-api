import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { requireAgent } from '../auth.ts'
import { DomainError, conflict, notFound } from '../errors.ts'
import { formEntries, initialForm, lineWorkflow, readingHash, selectedIndices, type FormOptions, type ReceiptForm } from '../receipt-form.ts'
import type { Tx } from '../db.ts'
import { createExpense, expenseBody } from './rms.ts'
import { annotateReceipt } from '../integrations/receipt-annotation.ts'
import { suggestReceiptLines } from '../receipt-learning.ts'

const ID = z.string().uuid()
const guard = { preHandler: requireAgent('BOOKKEEPER') }
const fieldMap = { merchant: 'Expense.vendor', invoice: 'Expense.receiptNo (supplier invoice, not internal ID)', date: 'Expense.businessDate', funding: 'Expense.paidBy', method: 'Expense.paymentMethod', category: 'Expense.category', brand: 'Expense.brandId', split: 'Expense.foodSplitPct; allocated amount snapshots via RMS rules', lines: 'ExpenseItem.name / quantityMilli / unit / unitPriceSen / totalSen', receipt: 'Expense.receiptDocumentId → ReceiptDocument → original/scan Drive IDs' }
const json = (v: unknown) => JSON.parse(JSON.stringify(v))
const expenseSnapshot = (expenses: Array<{ id: string; amountSen: number; brandId: string | null }>) => expenses.map(e => ({ id: e.id, amountSen: e.amountSen, brandId: e.brandId })).toSorted((a, b) => a.id.localeCompare(b.id))
async function queueAnnotation(tx: Tx, id: string, businessId: string) {
  const existing = await tx.receiptJob.findUnique({ where: { receiptId: id } })
  if (existing?.status === 'RUNNING' && existing.leaseUntil && existing.leaseUntil > new Date()) return
  await tx.receiptJob.upsert({ where: { receiptId: id }, create: { receiptId: id, businessId }, update: { status: 'PENDING', attempts: 0, leaseUntil: null, error: null } })
}
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
    const initial = initialForm(receipt, choices), ledger = lineWorkflow(receipt, initial.lines.length)
    const suggestions = stored ? [] : await suggestReceiptLines(db, initial, choices)
    ledger.decisions.forEach((d,i) => { if(d.state === 'posted' && initial.lines[i]) { initial.lines[i]!.brand=d.brand??null;initial.lines[i]!.category=d.category??null } })
    const form = stored?.readingHash === readingHash(receipt) && (stored.ledgerVersion ?? 0) === ledger.version ? { ...initial, ...stored, ledgerVersion: ledger.version, selectedIndices: stored.selectedIndices ?? initial.selectedIndices, stage: stored.stage ?? initial.stage } : initial
    if (stored && stored.ledgerVersion === undefined) form.lines = form.lines.map((l, i) => ({ ...l, category: l.category ?? initial.lines[i]?.category ?? null, brand: l.brand ?? initial.lines[i]?.brand ?? null }))
    const legacy = receipt.expenses.length > 0 && !(receipt.extracted as any)?._lineWorkflow
    const readOnly = ['LINKED', 'REJECTED'].includes(receipt.status) || legacy || !ledger.decisions.some(d => d.state === 'pending')
    return { receipt, form, ledger, readOnly, suggestions, reset: Boolean(stored && stored.readingHash !== form.readingHash) }
  }
  async function view(request: FastifyRequest, id: string) {
    const choices = await options(request)
    const { receipt, form, ledger, readOnly, reset, suggestions } = await load(request.db, request, id, choices)
    const matches = (await invoke(request, 'GET', `/agent/receipts/${id}/matches`)).matches.filter((m: any) => !receipt.expenses.some(e => e.id === m.expenseId))
    const duplicates = (await invoke(request, 'GET', `/agent/receipts/${id}/duplicates`)).candidates
    const pendingIndices = ledger.decisions.flatMap((d, i) => d.state === 'pending' ? [i] : [])
    // Visible provenance without changing the scanned reading.
    Object.assign(form, { suggestions, checks: (receipt.extracted as any)?._checks, documentType: (receipt.extracted as any)?.document_type ?? 'receipt', transactionDirection: (receipt.extracted as any)?.transaction_direction ?? null })
    return { receipt: { id, ref: `R-${id.slice(0, 6).toUpperCase()}`, vendor: receipt.vendor, date: receipt.receiptDate?.toISOString().slice(0, 10) ?? null, receiptNo: receipt.receiptNo, totalSen: receipt.totalSen, status: receipt.status, hasScan: Boolean(receipt.scanDriveFileId || (receipt.extracted as any)?.scan), photoAttached: Boolean(receipt.driveFileId || receipt.image), reviewFlags: receipt.reviewFlags, expenses: receipt.expenses }, form, options: choices, readingChanged: reset, readOnly, matches, duplicates, fieldMap, workflow: { ...ledger, pendingIndices, pendingSen: pendingIndices.reduce((s, i) => s + (form.lines[i]?.amountSen ?? 0), 0), postedSen: receipt.expenses.reduce((s, e) => s + e.amountSen, 0), scrappedSen: ledger.decisions.reduce((s, d, i) => s + (d.state === 'scrapped' ? form.lines[i]?.amountSen ?? 0 : 0), 0) } }
  }
  app.get<{ Params: { id: string } }>('/agent/receipts/:id/form', guard, request => view(request, ID.parse(request.params.id)))
  app.patch<{ Params: { id: string } }>('/agent/receipts/:id/form', guard, async request => {
    const id = ID.parse(request.params.id)
    const body = z.object({ version: z.number().int().min(0), ledgerVersion: z.number().int().min(0).optional(), field: z.enum(['category', 'brand', 'funding', 'method', 'split', 'selection', 'toggle', 'stage']), value: z.union([z.string(), z.number(), z.null(), z.array(z.number().int().min(0).max(99)).max(100)]), lineIndex: z.number().int().min(0).max(99).optional() }).parse(request.body)
    const choices = await options(request)
    await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const { receipt, form, ledger, readOnly } = await load(tx, request, id, choices)
      if (readOnly) throw conflict('agent:RECEIPT_DONE')
      if (body.version !== form.version || body.ledgerVersion !== undefined && body.ledgerVersion !== ledger.version) throw conflict('agent:FORM_STALE')
      const pending = ledger.decisions.flatMap((d, i) => d.state === 'pending' ? [i] : [])
      if (body.field === 'selection' || body.field === 'toggle') {
        let indices = body.value
        if (body.field === 'toggle') {
          if (typeof body.value !== 'number' || !pending.includes(body.value)) throw conflict('agent:FORM_OPTION_CHANGED')
          indices = selectedIndices(form).includes(body.value) ? selectedIndices(form).filter(i => i !== body.value) : [...selectedIndices(form), body.value]
        }
        if (!Array.isArray(indices) || new Set(indices).size !== indices.length || indices.some(i => !pending.includes(i))) throw conflict('agent:FORM_OPTION_CHANGED')
        form.selectedIndices = [...indices].sort((a, b) => a - b); form.stage = 'select'
      } else if (body.field === 'stage') {
        if (!['configure', 'select', 'remaining'].includes(String(body.value))) throw conflict('agent:FORM_OPTION_CHANGED')
        if (body.value === 'configure' && !selectedIndices(form).length) throw new DomainError('agent:FORM_INCOMPLETE', 400, 'Select at least one item first.')
        form.stage = body.value as ReceiptForm['stage']
      } else if (body.field === 'category' || body.field === 'brand') {
        const allowed = body.field === 'category' ? choices.categories.map(c => c.value) : [...choices.brands.map(b => b.id), ...(choices.split ? ['SHARED'] : [])]
        if (typeof body.value !== 'string' || !allowed.includes(body.value)) throw conflict('agent:FORM_OPTION_CHANGED')
        if (body.lineIndex !== undefined && (!form.lines[body.lineIndex] || !selectedIndices(form).includes(body.lineIndex))) throw notFound('agent:LINE_NOT_FOUND')
        const target = body.lineIndex === undefined ? selectedIndices(form).map(i => form.lines[i]!) : [form.lines[body.lineIndex]!]
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
      await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...extracted, _lineWorkflow: ledger, _entryForms: { ...extracted._entryForms, [request.agentUser!.id]: form } }) } })
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.form.updated', entityType: 'receipt', entityId: id, detail: body } })
    })
    return view(request, id)
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/preview', guard, async request => {
    const id = ID.parse(request.params.id), choices = await options(request)
    const { receipt, form, ledger, readOnly } = await load(request.db, request, id, choices)
    if (readOnly) throw conflict('agent:RECEIPT_DONE')
    const entries = formEntries(form, receipt, choices), append = receipt.expenses.length > 0
    const preview = await invoke(request, 'POST', `/agent/receipts/${id}/preview`, { entries, append })
    const confirmation = await request.db.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.form.previewed', entityType: 'receipt', entityId: id, detail: json({ entries, append, previewToken: preview.previewToken, version: form.version, readingHash: form.readingHash, ledgerVersion: ledger.version, indices: selectedIndices(form), choices, expenseSnapshot: expenseSnapshot(receipt.expenses) }) } })
    return { ...preview, selectedIndices: selectedIndices(form), remainingIndices: ledger.decisions.flatMap((d, i) => d.state === 'pending' && !selectedIndices(form).includes(i) ? [i] : []), confirmationId: confirmation.id.toString(), fieldMap, matches: (await invoke(request, 'GET', `/agent/receipts/${id}/matches`)).matches.filter((m: any) => !receipt.expenses.some(e => e.id === m.expenseId)) }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/post', guard, async request => {
    const id = ID.parse(request.params.id), body = z.object({ confirmationId: z.string().regex(/^\d{1,19}$/).refine(v => BigInt(v) <= 9223372036854775807n) }).parse(request.body)
    const choices = await options(request)
    const result = await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const action = await tx.agentAction.findFirst({ where: { id: BigInt(body.confirmationId), agentUserId: request.agentUser!.id, entityId: id, action: 'receipt.form.previewed' } })
      if (!action) throw notFound('agent:PREVIEW_NOT_FOUND')
      const saved = action.detail as any, { receipt, form, ledger, readOnly } = await load(tx, request, id, choices)
      if (readOnly) throw conflict('agent:RECEIPT_DONE')
      if (form.version !== saved.version || form.readingHash !== saved.readingHash || ledger.version !== saved.ledgerVersion || !isDeepStrictEqual(choices, saved.choices)) throw conflict('agent:FORM_STALE')
      const entries = saved.entries.map((e: unknown) => expenseBody.parse(e))
      // Financial/draft snapshots, not updatedAt: background annotation uploads
      // must not invalidate an otherwise identical human-reviewed selection.
      if (!isDeepStrictEqual(formEntries(form, receipt, choices), entries) || !isDeepStrictEqual(expenseSnapshot(receipt.expenses), saved.expenseSnapshot)) throw conflict('agent:PREVIEW_STALE')
      const owner = await tx.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
      if (!owner) throw conflict('agent:NO_OWNER')
      const ids: string[] = []
      for (const entry of entries) ids.push((await createExpense(tx, request.businessId, owner.id, entry, { receiptDocumentId: id })).id)
      for (const i of saved.indices as number[]) {
        const line = form.lines[i]!, group = entries.findIndex((e: any) => e.category === line.category && e.brandId === (line.brand === 'SHARED' ? null : line.brand))
        ledger.decisions[i] = { state: 'posted', brand: line.brand, category: line.category, expenseId: ids[group]!, actorId: request.agentUser!.id }
      }
      ledger.version++
      const pending = ledger.decisions.some(d => d.state === 'pending')
      await tx.receiptDocument.update({ where: { id }, data: { status: pending ? 'PENDING_REVIEW' : 'POSTED', resolvedAt: pending ? null : new Date(), extracted: json({ ...(receipt.extracted as any), _lineWorkflow: ledger, _entryForms: {}, _entryDefaults: { paidBy: form.paidBy, paymentMethod: form.paymentMethod } }) } })
      await queueAnnotation(tx, id, request.businessId)
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.posted', entityType: 'receipt', entityId: id, detail: json({ expenseIds: ids, entries, indices: saved.indices, confirmationId: body.confirmationId }) } })
      return { expenseIds: ids }
    })
    // Drive work is already durably queued. Never hold a committed financial
    // response hostage to a slow Google upload (the bridge times out at 60s).
    return { ...result, annotation: { pending: true }, next: await view(request, id) }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/scrap-preview', guard, async request => {
    const id = ID.parse(request.params.id), choices = await options(request), { form, ledger, readOnly } = await load(request.db, request, id, choices)
    if (readOnly) throw conflict('agent:RECEIPT_DONE')
    const indices = selectedIndices(form)
    if (!indices.length || indices.some(i => ledger.decisions[i]?.state !== 'pending')) throw conflict('agent:FORM_STALE')
    const action = await request.db.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.scrap.previewed', entityType: 'receipt', entityId: id, detail: json({ indices, version: form.version, ledgerVersion: ledger.version, readingHash: form.readingHash }) } })
    return { confirmationId: action.id.toString(), indices, lines: indices.map(i => form.lines[i]), message: 'Exclude these items from bookkeeping. No expense is posted; original evidence is preserved.' }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/scrap', guard, async request => {
    const id = ID.parse(request.params.id), body = z.object({ confirmationId: z.string().regex(/^\d{1,19}$/).refine(v => BigInt(v) <= 9223372036854775807n) }).parse(request.body), choices = await options(request)
    await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const action = await tx.agentAction.findFirst({ where: { id: BigInt(body.confirmationId), agentUserId: request.agentUser!.id, entityId: id, action: 'receipt.scrap.previewed' } })
      if (!action) throw notFound('agent:PREVIEW_NOT_FOUND')
      const { receipt, form, ledger, readOnly } = await load(tx, request, id, choices), saved = action.detail as any
      if (readOnly || form.version !== saved.version || ledger.version !== saved.ledgerVersion || form.readingHash !== saved.readingHash || saved.indices.some((i: number) => ledger.decisions[i]?.state !== 'pending')) throw conflict('agent:FORM_STALE')
      for (const i of saved.indices) ledger.decisions[i] = { state: 'scrapped', actorId: request.agentUser!.id }
      ledger.version++
      const status = ledger.decisions.some(d => d.state === 'pending') ? 'PENDING_REVIEW' : receipt.expenses.length ? 'POSTED' : 'SKIPPED'
      await tx.receiptDocument.update({ where: { id }, data: { status, extracted: json({ ...(receipt.extracted as any), _lineWorkflow: ledger, _entryForms: {} }) } })
      await queueAnnotation(tx, id, request.businessId)
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.items.scrapped', entityType: 'receipt', entityId: id, detail: json({ indices: saved.indices, confirmationId: body.confirmationId }) } })
    })
    return { annotation: { pending: true }, next: await view(request, id) }
  })
  app.get<{ Params: { id: string; confirmationId: string } }>('/agent/receipts/:id/form/confirmations/:confirmationId', guard, async request => {
    const id = ID.parse(request.params.id), confirmationId = z.string().regex(/^\d{1,19}$/).parse(request.params.confirmationId)
    const preview = await request.db.agentAction.findFirst({ where: { id: BigInt(confirmationId), agentUserId: request.agentUser!.id, entityId: id, action: { in: ['receipt.form.previewed', 'receipt.scrap.previewed'] } } })
    if (!preview) throw notFound('agent:PREVIEW_NOT_FOUND')
    const result = await request.db.agentAction.findFirst({ where: { agentUserId: request.agentUser!.id, entityId: id, action: { in: ['receipt.posted', 'receipt.items.scrapped'] }, detail: { path: ['confirmationId'], equals: confirmationId } } })
    return { state: !result ? 'unconfirmed' : result.action === 'receipt.posted' ? 'posted' : 'scrapped', expenseIds: (result?.detail as any)?.expenseIds ?? [], next: await view(request, id) }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/regions', guard, async request => {
    const id = ID.parse(request.params.id), choices = await options(request)
    const body = z.object({ readingHash: z.string().length(64), regions: z.array(z.object({ index: z.number().int().min(0).max(99), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1)).max(100) }).parse(request.body)
    await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const { receipt, form, ledger } = await load(tx, request, id, choices)
      if (readingHash(receipt) !== body.readingHash || new Set(body.regions.map(r => r.index)).size !== body.regions.length || body.regions.some(r => !form.lines[r.index])) throw conflict('agent:FORM_STALE')
      ledger.regions = body.regions
      // Positions annotate the immutable scan; they do not change allocation versions.
      if (ledger.annotation) ledger.annotation.version = -1
      await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...(receipt.extracted as any), _lineWorkflow: ledger }) } })
    })
    return annotateReceipt(request.db, id, request.businessId)
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/form/annotate', guard, async request => {
    const id = ID.parse(request.params.id)
    await load(request.db, request, id, await options(request))
    return annotateReceipt(request.db, id, request.businessId)
  })
}
