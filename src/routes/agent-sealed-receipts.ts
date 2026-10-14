import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { env } from '../env.ts'
import { conflict, forbidden } from '../errors.ts'
import { readFromDrive, withinFinances } from '../integrations/drive.ts'
import { createExpense, expenseBody, previewExpense } from './rms.ts'
import { chopperPreview, chopperSubmit } from './agent-chopper.ts'

const draft = z.object({
  receiptId: z.string().uuid(), submissionId: z.string().uuid(),
  fileId: z.string().regex(/^[A-Za-z0-9_-]{5,200}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  vendor: z.string().max(120), receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  receiptNo: z.string().max(60).nullable(), totalSen: z.number().int().positive(),
  reading: z.record(z.string(), z.unknown()), entries: z.array(expenseBody).min(1).max(100),
})
type Draft = z.infer<typeof draft>
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function signature(request: FastifyRequest, body: Draft, until: number) {
  return createHmac('sha256', env.JWT_SECRET).update(JSON.stringify([request.businessId, request.agentUser!.id, until, body])).digest('hex')
}
async function evidence(request: FastifyRequest, body: Draft) {
  if (request.businessId !== env.DRIVE_BUSINESS_ID) throw forbidden('agent:DRIVE_NOT_BOUND')
  const file = await withinFinances(body.fileId)
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimeType) || Number(file.size) > 3 * 1024 * 1024) throw conflict('agent:INVALID_SCAN')
  if (createHash('sha256').update(await readFromDrive(file.id)).digest('hex') !== body.sha256) throw conflict('agent:SCAN_CHANGED')
  if (body.entries.some(e => e.businessDate !== body.receiptDate) || body.entries.reduce((n, e) => n + e.amountSen, 0) > body.totalSen) throw conflict('agent:TOTAL_MISMATCH')
  return file
}

/** Chopper owns all drafts; this route stores only acknowledged submissions. */
export async function agentSealedReceiptRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireAgent('BOOKKEEPER') }
  app.get('/agent/chopper/context', guard, async request => ({ businessId: request.businessId, agentUserId: request.agentUser!.id, role: request.agentUser!.role }))
  app.post('/agent/chopper/preview', guard, async request => {
    // Keyed by Chopper's receipt key: the Drive-first booking flow. Otherwise the original UUID shape.
    if ((request.body as any)?.receiptKey !== undefined) return chopperPreview(request)
    const body = draft.parse(request.body)
    await evidence(request, body)
    const entries = []
    for (const entry of body.entries) entries.push({ ...entry, allocation: await previewExpense(request.db, request.businessId, entry) })
    const until = Date.now() + 20 * 60_000
    return { entries, amountSen: body.entries.reduce((n, e) => n + e.amountSen, 0), previewToken: `${until}.${signature(request, body, until)}`, persistsDraft: false }
  })
  app.post('/agent/chopper/submit', guard, async request => {
    if ((request.body as any)?.payload?.receiptKey !== undefined) return chopperSubmit(request)
    const { payload, previewToken } = z.object({ payload: draft, previewToken: z.string() }).parse(request.body)
    // Readback recovery precedes expiry checks. A lost response must never post twice.
    const prior = await request.db.agentAction.findFirst({ where: { action: 'chopper.receipt.sealed', entityId: payload.submissionId } })
    if (prior) {
      const saved = prior.detail as any
      if (prior.agentUserId !== request.agentUser!.id || saved.digest !== digest(payload)) throw conflict('agent:SUBMISSION_CHANGED')
      return { ...saved.result, alreadySubmitted: true }
    }
    const [expiry, supplied = ''] = previewToken.split('.'), until = Number(expiry)
    const expected = signature(request, payload, until)
    if (!Number.isFinite(until) || until < Date.now() || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw conflict('agent:PREVIEW_STALE')
    const file = await evidence(request, payload)
    return request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + payload.receiptId}))::text`
      if (payload.receiptNo?.trim()) {
        const businessIdentity = [request.businessId, payload.vendor.trim().toLowerCase(), payload.receiptNo.trim().toLowerCase(), payload.receiptDate, payload.totalSen].join(':')
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessIdentity}))::text`
        const duplicate = await tx.receiptDocument.findFirst({ where: {
          id: { not: payload.receiptId }, vendor: { equals: payload.vendor.trim(), mode: 'insensitive' },
          receiptNo: { equals: payload.receiptNo.trim(), mode: 'insensitive' },
          receiptDate: new Date(payload.receiptDate + 'T00:00:00Z'), totalSen: payload.totalSen,
          expenses: { some: {} },
        } })
        if (duplicate) throw conflict('agent:DUPLICATE_INVOICE_REUSE_CANONICAL_RECEIPT')
      }
      const done = await tx.agentAction.findFirst({ where: { action: 'chopper.receipt.sealed', entityId: payload.submissionId } })
      if (done) {
        const saved = done.detail as any
        if (done.agentUserId !== request.agentUser!.id || saved.digest !== digest(payload)) throw conflict('agent:SUBMISSION_CHANGED')
        return { ...saved.result, alreadySubmitted: true }
      }
      const existing = await tx.receiptDocument.findFirst({ where: { OR: [{ id: payload.receiptId }, { sha256: payload.sha256 }] }, include: { expenses: true } })
      if (existing && (existing.id !== payload.receiptId || existing.scanDriveFileId !== payload.fileId && existing.driveFileId !== payload.fileId)) throw conflict('agent:DUPLICATE_EVIDENCE')
      const already = existing?.expenses.reduce((n, e) => n + e.amountSen, 0) ?? 0
      if (already + payload.entries.reduce((n, e) => n + e.amountSen, 0) > payload.totalSen) throw conflict('agent:TOTAL_MISMATCH')
      if (!existing) await tx.receiptDocument.create({ data: {
        id: payload.receiptId, businessId: request.businessId, status: 'POSTED', sha256: payload.sha256,
        mimeType: file.mimeType, driveFileId: file.id, driveUrl: file.webViewLink ?? null,
        scanDriveFileId: file.mimeType === 'application/pdf' ? null : file.id, scanDriveUrl: file.webViewLink ?? null,
        vendor: payload.vendor, receiptDate: new Date(payload.receiptDate + 'T00:00:00Z'), receiptNo: payload.receiptNo,
        totalSen: payload.totalSen, uploadedById: request.agentUser!.id, resolvedAt: new Date(),
        extracted: JSON.parse(JSON.stringify({ ...payload.reading, _chopper: { sealed: true, key: payload.receiptId }, _inbox: { originalRetired: true } })),
      } })
      const owner = await tx.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
      if (!owner) throw conflict('agent:NO_OWNER')
      const expenseIds = []
      for (const entry of payload.entries) expenseIds.push((await createExpense(tx, request.businessId, owner.id, entry, { receiptDocumentId: payload.receiptId })).id)
      const result = { receiptId: payload.receiptId, submissionId: payload.submissionId, expenseIds, fileId: payload.fileId }
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'chopper.receipt.sealed', entityType: 'receipt', entityId: payload.submissionId, detail: JSON.parse(JSON.stringify({ digest: digest(payload), result })) } })
      return result
    })
  })
}
