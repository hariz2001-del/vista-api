import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { conflict, notFound } from '../errors.ts'
import { sameVendor } from '../receipt-matching.ts'
import { agentClock } from '../domain/agent-clock.ts'
import { env } from '../env.ts'
import { driveConfigured } from '../integrations/drive.ts'
import { readingHash } from '../receipt-form.ts'

const id = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
const read = { preHandler: requireAgent('VIEWER') }
const owner = { preHandler: requireAgent('OWNER') }
const write = { preHandler: requireAgent('BOOKKEEPER') }
async function audit(request: FastifyRequest, action: string, entityId: string, detail: unknown) {
  await request.db.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action, entityType: 'business', entityId, detail: json(detail) } })
}

// Deliberate data contracts, not SQL or credentials. Team reads remain in operations.
const resources = {
  brands: ['brand', ['id', 'name', 'sortOrder']],
  products: ['product', ['id', 'brandId', 'categoryId', 'name', 'description', 'basePriceSen', 'isActive', 'isSoldOut']],
  categories: ['category', ['id', 'brandId', 'name']],
  addons: ['modifierItem', ['id', 'modifierGroupId', 'name', 'priceSen']],
  orders: ['order', ['id', 'businessDate', 'queueNumber', 'totalAmountSen', 'createdAt']],
  'order-items': ['orderItem', ['id', 'orderId', 'productId', 'productName', 'brandId', 'quantity', 'unitPriceSen', 'modifierTotalSen', 'lineDiscountSen', 'allocatedOrderDiscountSen']],
  'sold-addons': ['orderItemModifier', ['id', 'orderItemId', 'modifierItemId', 'name', 'priceSen', 'type']],
  ledger: ['ledgerEntry', ['id', 'businessDate', 'brandId', 'direction', 'amountSen', 'category', 'description']],
  expenses: ['expense', ['id', 'businessDate', 'brandId', 'amountSen', 'vendor', 'receiptNo', 'description', 'category', 'paidBy', 'paymentMethod', 'receiptDocumentId', 'receiptUrl']],
  receipts: ['receiptDocument', ['id', 'status', 'vendor', 'receiptDate', 'receiptNo', 'totalSen', 'driveUrl', 'scanDriveUrl']],
} as const

export async function agentBusinessRoutes(app: FastifyInstance) {
  app.get('/agent/time', read, async request => {
    const settings = await request.db.accountSettings.findUnique({ where: { businessId: request.businessId } })
    return agentClock(new Date(), settings?.dayRolloverHour ?? 5)
  })
  app.get<{ Params: { id: string } }>('/agent/receipts/:id/telegram-context', write, async request => {
    const r = await request.db.receiptDocument.findUnique({ where: { id: id.parse(request.params.id) } })
    if (!r) throw notFound('agent:RECEIPT_NOT_FOUND')
    return { chatId: r.telegramChatId?.toString() ?? null, messageId: r.telegramMessageId?.toString() ?? null, notified: Boolean((r.extracted as any)?.telegramReadingNotified), suppressNotification: Boolean((r.extracted as any)?._inbox?.suppressNotification), receiptId: r.id }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/notification', write, async request => {
    const r = await request.db.receiptDocument.findUnique({ where: { id: id.parse(request.params.id) } })
    if (!r) throw notFound('agent:RECEIPT_NOT_FOUND')
    await request.db.receiptDocument.update({ where: { id: r.id }, data: { extracted: { ...(r.extracted as object), telegramReadingNotified: true } } })
    return { saved: true }
  })
  app.get('/agent/data', owner, async () => ({ resources: Object.keys(resources), note: 'Paginated business-only operational records. No passwords, sessions, keys or raw SQL. Staff/rosters/payroll/stock use operations.' }))
  app.get<{ Params: { resource: string } }>('/agent/data/:resource', owner, async request => {
    const resource = resources[request.params.resource as keyof typeof resources]
    if (!resource) throw notFound('agent:RESOURCE_NOT_FOUND')
    const q = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50), id: z.string().max(100).optional() }).parse(request.query)
    const delegate = (request.db as any)[resource[0]]
    const rows = await delegate.findMany({ where: q.id ? { id: q.id } : {}, select: Object.fromEntries(resource[1].map(field => [field, true])), orderBy: { id: 'asc' }, skip: q.offset, take: q.limit + 1 })
    return json({ rows: rows.slice(0, q.limit), nextOffset: rows.length > q.limit ? q.offset + q.limit : null })
  })

  app.get('/agent/item-sales', read, async request => {
    const q = z.object({ from: date, to: date, productId: id.optional(), name: z.string().trim().min(1).max(120).optional() }).parse(request.query)
    if (q.from > q.to || new Date(q.to).getTime() - new Date(q.from).getTime() > 366 * 86400000) throw conflict('agent:INVALID_RANGE')
    const items = await request.db.orderItem.findMany({ where: { ...(q.productId ? { productId: q.productId } : {}), ...(q.name ? { productName: { contains: q.name, mode: 'insensitive' } } : {}), order: { businessDate: { gte: new Date(q.from), lte: new Date(q.to) } } }, include: { modifiers: true, order: { select: { businessDate: true } } }, take: 10001 })
    if (items.length > 10000) throw conflict('agent:RANGE_TOO_LARGE')
    const groups = new Map<string, any>()
    for (const item of items) {
      const key = `${item.productId}:${item.productName}`
      const row = groups.get(key) ?? { productId: item.productId, name: item.productName, brandId: item.brandId, qty: 0, baseSen: 0, addonSen: 0, discountsSen: 0, addons: {} }
      row.qty += item.quantity; row.baseSen += item.unitPriceSen * item.quantity
      row.addonSen += item.modifierTotalSen * item.quantity
      row.discountsSen += item.lineDiscountSen + item.allocatedOrderDiscountSen
      for (const mod of item.modifiers) {
        const k = `${mod.type}:${mod.name}:${mod.priceSen}`
        const addon = row.addons[k] ?? { name: mod.name, type: mod.type, unitPriceSen: mod.priceSen, qty: 0, revenueSen: 0 }
        addon.qty += item.quantity; addon.revenueSen += mod.priceSen * item.quantity; row.addons[k] = addon
      }
      groups.set(key, row)
    }
    return { from: q.from, to: q.to, items: [...groups.values()].map(row => ({ ...row, addons: Object.values(row.addons), rungUpNetSen: row.baseSen + row.addonSen - row.discountsSen })), note: 'Historical names/prices as rung up; later order-level refunds/cancellations are in net-sales/ledger, not attributed to individual addons. Revenue is not ingredient cost.' }
  })

  app.get<{ Params: { id: string } }>('/agent/receipts/:id/duplicates', read, async request => {
    const receipt = await request.db.receiptDocument.findUnique({ where: { id: id.parse(request.params.id) } })
    if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
    if (!receipt.receiptNo && !receipt.receiptDate) return { candidates: [], note: 'Read vendor/date/number/total first. Never decide solely from amount.' }
    const candidates = await request.db.receiptDocument.findMany({ where: { id: { not: receipt.id }, status: { not: 'REJECTED' }, OR: [...(receipt.receiptNo ? [{ receiptNo: { equals: receipt.receiptNo, mode: 'insensitive' as const } }] : []), ...(receipt.receiptDate ? [{ receiptDate: receipt.receiptDate }] : [])] }, include: { expenses: { select: { id: true, brandId: true, amountSen: true } } }, take: 200 })
    return { candidates: candidates.flatMap(row => {
      if (!sameVendor(receipt.vendor, row.vendor)) return []
      const reasons = ['same merchant identity']
      if (receipt.receiptNo && receipt.receiptNo.toLowerCase() === row.receiptNo?.toLowerCase()) reasons.push('same invoice number')
      if (receipt.receiptDate?.getTime() === row.receiptDate?.getTime() && receipt.receiptDate) reasons.push('same date')
      if (receipt.totalSen !== null && receipt.totalSen === row.totalSen) reasons.push('same total')
      if (!reasons.includes('same invoice number') && !(reasons.includes('same date') && reasons.includes('same total'))) return []
      const allocatedSen = row.expenses.reduce((sum, expense) => sum + expense.amountSen, 0)
      return [{ id: row.id, ref: `R-${row.id.slice(0, 6).toUpperCase()}`, vendor: row.vendor, date: row.receiptDate?.toISOString().slice(0, 10), totalSen: row.totalSen, allocatedSen, remainingSen: row.totalSen === null ? null : row.totalSen - allocatedSen, expenses: row.expenses, reasons, driveUrl: row.driveUrl }]
    }), note: 'Possible same physical receipt, not proof of duplicate spending. Ask whether this is another brand allocation, a historical attachment, or a separate purchase.' }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/reuse', write, async request => {
    const receiptId = id.parse(request.params.id), body = z.object({ canonicalId: id, reason: z.string().trim().min(1).max(500) }).parse(request.body)
    if (body.canonicalId === receiptId) throw conflict('agent:SAME_RECEIPT')
    return request.db.$transaction(async tx => {
      // Lock both deterministically; do not rewrite any accounting entry.
      const ids = [receiptId, body.canonicalId].toSorted()
      for (const key of ids) await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${key} AND business_id = ${request.businessId} FOR UPDATE`
      const source = await tx.receiptDocument.findUnique({ where: { id: receiptId }, include: { expenses: true } })
      const target = await tx.receiptDocument.findUnique({ where: { id: body.canonicalId }, include: { expenses: true } })
      if (!source || !target) throw notFound('agent:RECEIPT_NOT_FOUND')
      if (source.expenses.length || source.status === 'POSTED' || target.status === 'REJECTED') throw conflict('agent:RECEIPT_ALREADY_ALLOCATED')
      const extracted = { ...(source.extracted as object), duplicateOf: target.id, duplicateReason: body.reason }
      await tx.receiptDocument.update({ where: { id: receiptId }, data: { status: 'REJECTED', extracted, resolvedAt: new Date() } })
      await tx.receiptJob.updateMany({ where: { receiptId }, data: { status: 'DONE', leaseUntil: null } })
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'receipt.reused', entityType: 'receipt', entityId: receiptId, detail: body } })
      return { canonicalReceiptId: target.id, expenses: target.expenses.map(e => ({ id: e.id, brandId: e.brandId, amountSen: e.amountSen })), note: 'Use this existing receipt and Drive files for further confirmed allocations/linking. Alternate photo preserved; no expense created and no Drive file deleted.' }
    })
  })

  app.get('/agent/queue', read, async request => {
    const q = z.object({ eligible: z.enum(['true', 'false']).optional() }).parse(request.query)
    return { jobs: await request.db.receiptJob.findMany({ where: q.eligible === 'true' ? { attempts: { lt: 5 }, OR: [{ status: 'PENDING' }, { status: 'RUNNING', leaseUntil: { lt: new Date() } }] } : { status: { not: 'DONE' } }, orderBy: { createdAt: 'asc' }, take: 50 }) }
  })
  app.post('/agent/queue/claim', write, async request => request.db.$transaction(async tx => {
    const now = new Date()
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM receipt_jobs WHERE business_id = ${request.businessId} AND attempts < 5 AND (status = 'PENDING' OR (status = 'RUNNING' AND lease_until < (${now}::timestamptz AT TIME ZONE 'UTC'))) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
    if (!rows[0]) return { job: null }
    const leaseUntil = new Date(now.getTime() + 10 * 60000)
    const job = await tx.receiptJob.update({ where: { id: rows[0].id }, data: { status: 'RUNNING', leaseUntil, attempts: { increment: 1 }, error: null } })
    return { job, leaseToken: leaseUntil.toISOString() }
  }))
  app.post<{ Params: { id: string } }>('/agent/queue/:id/finish', write, async request => {
    const body = z.object({ leaseToken: z.string().datetime(), error: z.string().max(1000).optional() }).parse(request.body)
    const jobId = id.parse(request.params.id)
    // Deterministic final checks: a worker cannot accidentally finish an
    // auto-stashed receipt without checking both ledgers and Drive evidence.
    const candidate=await request.db.receiptJob.findUnique({where:{id:jobId}})
    const boundDrive=driveConfigured() && env.DRIVE_BUSINESS_ID===request.businessId
    if(!body.error && boundDrive && candidate?.status==='RUNNING' && candidate.leaseUntil?.toISOString()===body.leaseToken) {
      const result=await app.inject({method:'POST',url:`/agent/receipts/${candidate.receiptId}/checks`,payload:{},headers:{authorization:request.headers.authorization!,'x-telegram-user':request.agentUser!.telegramUserId}})
      if(result.statusCode>=400) body.error='Evidence cross-check incomplete; retry needed.'
    }
    return request.db.$transaction(async tx => {
    const job = await tx.receiptJob.findUnique({ where: { id: jobId } })
    if (!job || job.status !== 'RUNNING' || job.leaseUntil?.toISOString() !== body.leaseToken || job.leaseUntil < new Date()) throw conflict('agent:LEASE_STALE')
    await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${job.receiptId} AND business_id = ${request.businessId} FOR UPDATE`
    const receipt = await tx.receiptDocument.findUnique({ where: { id: job.receiptId } })
    const workflow = (receipt?.extracted as any)?._lineWorkflow
    const extracted=receipt?.extracted as any, checks=extracted?._checks
    const needsEvidence=boundDrive && receipt && (!receipt.driveFileId || receipt.mimeType!=='application/pdf' && !receipt.scanDriveFileId || !(extracted?.lines?.length || extracted?.document_type==='bank_screenshot') || !checks || checks.readingHash!==readingHash(receipt) || receipt.receiptNo && !checks.drive?.checked)
    const needsAnnotation = !body.error && workflow?.decisions.some((d: any) => d.state !== 'pending') && workflow.annotation?.version !== workflow.version
    // An allocation can arrive during a running OCR/annotation lease. Do not
    // lose that newer work by marking the old generation DONE.
    const result = await tx.receiptJob.updateMany({ where: { id: jobId, status: 'RUNNING', leaseUntil: new Date(body.leaseToken) }, data: { status: body.error || needsAnnotation || needsEvidence ? job.attempts >= 5 ? 'FAILED' : 'PENDING' : 'DONE', error: body.error ?? (needsEvidence ? 'Reading/scan/Drive/checks incomplete.' : needsAnnotation ? 'Newer allocation annotation pending.' : null), leaseUntil: null } })
    if (!result.count) throw conflict('agent:LEASE_STALE')
    return { saved: true }
    })
  })

  app.get('/agent/reconciliation', owner, async request => {
    const q = z.object({ status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN') }).parse(request.query)
    return { cases: await request.db.reconciliationCase.findMany({ where: q.status === 'ALL' ? {} : { status: q.status }, orderBy: { createdAt: 'asc' }, take: 100 }) }
  })
  app.post('/agent/reconciliation/refresh', owner, async request => {
    const expenses = await request.db.expense.findMany({ where: { receiptDocumentId: null, OR: [{ receiptUrl: null }, { receiptUrl: '' }], category: { not: 'WAGES' } }, select: { id: true, businessDate: true, amountSen: true, vendor: true, receiptNo: true, description: true }, take: 1000 })
    for (const expense of expenses) await request.db.reconciliationCase.upsert({ where: { businessId_key: { businessId: request.businessId, key: `missing:${expense.id}` } }, create: { businessId: request.businessId, key: `missing:${expense.id}`, kind: 'MISSING_RECEIPT', detail: json(expense) }, update: { detail: json(expense) } })
    const receipts = await request.db.expense.findMany({ where: { OR: [{ receiptDocumentId: { not: null } }, { receiptUrl: { not: null } }] }, select: { id: true, receiptDocumentId: true, receiptUrl: true }, take: 10000 })
    await request.db.reconciliationCase.updateMany({ where: { key: { in: receipts.filter(row => row.receiptDocumentId || row.receiptUrl).map(row => `missing:${row.id}`) }, kind: 'MISSING_RECEIPT', status: 'OPEN' }, data: { status: 'RESOLVED', resolution: 'Supporting receipt attached in Vista.' } })
    await audit(request, 'reconciliation.refreshed', 'missing-receipts', { reviewed: expenses.length })
    return { reviewed: expenses.length, limit: 1000, note: 'Persistent missing-receipt cases refreshed. Missing evidence is not proof of an invalid expense; no accounting entry changed.' }
  })
  app.post('/agent/reconciliation', owner, async request => {
    const body = z.object({ key: z.string().min(1).max(200), kind: z.enum(['MISSING_RECEIPT', 'POSSIBLE_DUPLICATE', 'BANK_DIFFERENCE', 'OTHER']), detail: z.record(z.string(), z.unknown()) }).parse(request.body)
    const item = await request.db.reconciliationCase.upsert({ where: { businessId_key: { businessId: request.businessId, key: body.key } }, create: { ...body, businessId: request.businessId, detail: json(body.detail) }, update: { detail: json(body.detail) } })
    await audit(request, 'reconciliation.recorded', item.id, body)
    return { case: item }
  })
  app.patch<{ Params: { id: string } }>('/agent/reconciliation/:id', owner, async request => {
    const body = z.object({ status: z.enum(['OPEN', 'RESOLVED']), resolution: z.string().trim().min(1).max(2000) }).parse(request.body)
    const caseId = id.parse(request.params.id)
    const changed = await request.db.reconciliationCase.updateMany({ where: { id: caseId }, data: body })
    if (!changed.count) throw notFound('agent:CASE_NOT_FOUND')
    await audit(request, 'reconciliation.updated', caseId, body)
    return { saved: true, note: 'Issue state only; accounting records unchanged.' }
  })

  app.get<{ Params: { id: string } }>('/agent/products/:id/cost', owner, async request => {
    const product = await request.db.product.findUnique({ where: { id: id.parse(request.params.id) }, include: { recipe: true } })
    if (!product) throw notFound('agent:PRODUCT_NOT_FOUND')
    const recipe = product.recipe
    if (!recipe) return { productId: product.id, name: product.name, sellingPriceSen: product.basePriceSen, costAvailable: false, missing: 'Owner-provided recipe quantities and purchase unit costs. Do not derive costs from selling prices.' }
    const components = (recipe.components as Array<{ name: string; quantityMilli: number; unitCostSen: number; unit: string }>).map(c => ({ ...c, costSen: Math.round(c.quantityMilli * c.unitCostSen / 1000) }))
    const costSen = components.reduce((sum, c) => sum + c.costSen, recipe.overheadSen)
    return { productId: product.id, name: product.name, sellingPriceSen: product.basePriceSen, costAvailable: true, components, overheadSen: recipe.overheadSen, costSen, baseMarginSen: product.basePriceSen - costSen, source: recipe.source, effectiveDate: recipe.effectiveDate.toISOString().slice(0, 10), note: 'Current recorded recipe estimate, excluding addon costs and unrecorded labour/overheads. Not historical realised profit.' }
  })
  app.put<{ Params: { id: string } }>('/agent/products/:id/cost', owner, async request => {
    const productId = id.parse(request.params.id)
    const body = z.object({ components: z.array(z.object({ name: z.string().trim().min(1).max(120), unit: z.string().trim().min(1).max(40), quantityMilli: z.number().int().min(1).max(100000000), unitCostSen: z.number().int().min(0).max(10000000) })).min(1).max(100), overheadSen: z.number().int().min(0).max(10000000).default(0), source: z.string().trim().min(1).max(1000), effectiveDate: date }).parse(request.body)
    if (!await request.db.product.findUnique({ where: { id: productId } })) throw notFound('agent:PRODUCT_NOT_FOUND')
    await request.db.$transaction(async tx => {
      const data = { ...body, components: json(body.components), effectiveDate: new Date(body.effectiveDate) }
      await tx.productRecipe.upsert({ where: { productId }, create: { ...data, businessId: request.businessId, productId }, update: data })
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'recipe.updated', entityType: 'product', entityId: productId, detail: body } })
    })
    return { saved: true }
  })
}
