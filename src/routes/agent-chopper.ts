import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import type { Tx } from '../db.ts'
import { env } from '../env.ts'
import { badRequest, conflict, forbidden, notFound } from '../errors.ts'
import { readFromDrive, withinFinances, type DriveFile } from '../integrations/drive.ts'
import { createExpense, expenseBody, previewExpense } from './rms.ts'

/**
 * Chopper's booking API, keyed by its own receipt key ("R-5AE50F"). Chopper owns
 * the scan and the stash; Vista stores only confirmed expenses and where their
 * scan lives. Preview writes nothing; submit and link run once per submission ID.
 */

const KEY = z.string().regex(/^R-[0-9A-F]{6}$/)
const SHA = z.string().regex(/^[a-f0-9]{64}$/)
const FILE_ID = z.string().regex(/^[A-Za-z0-9_-]{5,200}$/)
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const fileLink = { driveFileId: FILE_ID, fileName: z.string().trim().min(1).max(250), drivePath: z.string().trim().min(1).max(500) }

export const chopperBooking = z.object({
  receiptKey: KEY,
  submissionId: z.string().uuid(),
  entries: z.array(expenseBody).min(1).max(100),
  receipt: z.object({
    vendor: z.string().trim().min(1).max(120),
    date: DATE,
    receiptNo: z.string().trim().max(60).nullish().transform(v => v || null),
    totalSen: z.number().int().positive(),
    sha256: SHA,
    ...fileLink,
  }),
})
type Booking = z.infer<typeof chopperBooking>
const linkBody = z.object({ receiptKey: KEY, expenseIds: z.array(z.string().uuid()).min(1).max(50), sha256: SHA, ...fileLink })
type LinkBody = z.infer<typeof linkBody>

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sign = (parts: unknown[]) => createHmac('sha256', env.JWT_SECRET).update(JSON.stringify(['chopper', ...parts])).digest('hex')
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const PREVIEW_MS = 30 * 60_000

/** What would be saved, exactly: receipt vendor/number fill entries that left them out. */
function normalise(body: Booking): Booking {
  return { ...body, entries: body.entries.map(e => ({ ...e, vendor: e.vendor ?? body.receipt.vendor, receiptNo: e.receiptNo ?? body.receipt.receiptNo })) }
}

/** The Drive scan must be in Finances and be the exact bytes Chopper read. */
async function verifyScan(request: FastifyRequest, fileId: string, sha256: string): Promise<DriveFile> {
  if (request.businessId !== env.DRIVE_BUSINESS_ID && request.businessId !== env.DRIVE_TEST_BUSINESS_ID) throw forbidden('agent:DRIVE_NOT_BOUND')
  let file: DriveFile
  try { file = await withinFinances(fileId) } catch { throw conflict('agent:SCAN_CHANGED', 'scan not found in Finances, or trashed') }
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimeType)) throw conflict('agent:SCAN_CHANGED', 'scan must be a JPEG, PNG or PDF')
  if (createHash('sha256').update(await readFromDrive(file.id)).digest('hex') !== sha256) throw conflict('agent:SCAN_CHANGED')
  return file
}

/** By Chopper's key; receipts from before Chopper chose keys answer to "R-" + their ID's first 6 hex. */
async function receiptByKey(db: Tx, key: string) {
  const own = await db.receiptDocument.findFirst({ where: { receiptKey: key }, include: { expenses: { select: { id: true, amountSen: true } } } })
  if (own) return own
  const legacy = await db.receiptDocument.findMany({ where: { receiptKey: null, id: { startsWith: key.slice(2).toLowerCase() } }, include: { expenses: { select: { id: true, amountSen: true } } }, take: 2 })
  return legacy.length === 1 ? legacy[0]! : null
}
const keyOf = (r: { id: string; receiptKey: string | null }) => r.receiptKey ?? `R-${r.id.slice(0, 6).toUpperCase()}`
const linkOf = (r: { id: string; receiptKey: string | null; scanDriveFileId: string | null; driveFileId: string | null; fileName: string | null; drivePath: string | null; sha256: string }) =>
  ({ receiptKey: keyOf(r), driveFileId: r.scanDriveFileId ?? r.driveFileId, fileName: r.fileName, drivePath: r.drivePath, sha256: r.sha256 })

/** A stored submission answers a retry; the same ID with another payload is refused. */
async function stored(db: Tx, submissionId: string, hash: string) {
  const prior = await db.chopperSubmission.findFirst({ where: { submissionId } })
  if (!prior) return null
  if (prior.digest !== hash) throw conflict('agent:SUBMISSION_CHANGED')
  return { ...(prior.result as object), alreadySubmitted: true }
}
const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

export async function chopperPreview(request: FastifyRequest) {
  const body = normalise(chopperBooking.parse(request.body))
  if (body.entries.some(e => e.businessDate !== body.receipt.date)) throw badRequest('agent:TOTAL_MISMATCH', 'every entry must be dated the receipt date')
  await verifyScan(request, body.receipt.driveFileId, body.receipt.sha256)
  const existing = await receiptByKey(request.db, body.receiptKey)
  if (existing && existing.sha256 !== body.receipt.sha256) throw conflict('agent:DUPLICATE_EVIDENCE', 'this receipt key is booked with a different scan')
  const booked = existing?.expenses.reduce((n, e) => n + e.amountSen, 0) ?? 0
  if (booked + body.entries.reduce((n, e) => n + e.amountSen, 0) > body.receipt.totalSen) throw conflict('agent:TOTAL_MISMATCH')
  const entries = []
  for (const entry of body.entries) entries.push({ ...entry, ...await previewExpense(request.db, request.businessId, entry) })
  const previewHash = digest(body), until = Date.now() + PREVIEW_MS
  return { previewToken: `${until}.${previewHash}.${sign([request.businessId, until, previewHash])}`, previewHash, entries, alreadyBookedSen: booked, expiresAt: new Date(until).toISOString() }
}

export async function chopperSubmit(request: FastifyRequest) {
  const { submissionId, previewToken, payload: raw } = z.object({ submissionId: z.string().uuid(), previewToken: z.string().max(300), payload: chopperBooking }).parse(request.body)
  const payload = normalise(raw), hash = digest(payload)
  if (payload.submissionId !== submissionId) throw badRequest('agent:PREVIEW_MISMATCH', 'submissionId differs from the payload')
  // A lost response is answered before the token is checked, so a late retry never posts twice.
  const prior = await stored(request.db, submissionId, hash)
  if (prior) return prior
  const [expiry = '', previewHash = '', mac = ''] = previewToken.split('.'), until = Number(expiry)
  if (!Number.isFinite(until) || !sameHex(mac, sign([request.businessId, until, previewHash]))) throw conflict('agent:PREVIEW_STALE')
  if (previewHash !== hash) throw conflict('agent:PREVIEW_MISMATCH')
  if (until < Date.now()) throw conflict('agent:PREVIEW_STALE')
  const file = await verifyScan(request, payload.receipt.driveFileId, payload.receipt.sha256)
  const r = payload.receipt
  try {
    return await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + payload.receiptKey}))::text`
      const again = await stored(tx, submissionId, hash)
      if (again) return again
      if (r.receiptNo) {
        const twin = await tx.receiptDocument.findFirst({ where: {
          OR: [{ receiptKey: { not: payload.receiptKey } }, { receiptKey: null }],
          vendor: { equals: r.vendor, mode: 'insensitive' }, receiptNo: { equals: r.receiptNo, mode: 'insensitive' },
          receiptDate: new Date(r.date + 'T00:00:00Z'), totalSen: r.totalSen, expenses: { some: {} },
        } })
        if (twin && keyOf(twin) !== payload.receiptKey) throw conflict('agent:DUPLICATE_INVOICE', keyOf(twin))
      }
      let receipt = await receiptByKey(tx, payload.receiptKey)
      if (receipt && receipt.sha256 !== r.sha256) throw conflict('agent:DUPLICATE_EVIDENCE', 'this receipt key is booked with a different scan')
      if (!receipt) {
        const sameImage = await tx.receiptDocument.findFirst({ where: { sha256: r.sha256 } })
        if (sameImage) throw conflict('agent:DUPLICATE_EVIDENCE', keyOf(sameImage))
        await tx.receiptDocument.create({ data: {
          id: randomUUID(), businessId: request.businessId, receiptKey: payload.receiptKey, status: 'POSTED', sha256: r.sha256,
          mimeType: file.mimeType, driveFileId: file.id, driveUrl: file.webViewLink ?? null, scanDriveFileId: file.id, scanDriveUrl: file.webViewLink ?? null,
          fileName: r.fileName, drivePath: r.drivePath, vendor: r.vendor, receiptDate: new Date(r.date + 'T00:00:00Z'), receiptNo: r.receiptNo, totalSen: r.totalSen,
          uploadedById: request.agentUser!.id, resolvedAt: new Date(),
          extracted: { _chopper: { sealed: true, key: payload.receiptKey }, _inbox: { originalRetired: true } },
        } })
        receipt = (await receiptByKey(tx, payload.receiptKey))!
      }
      const booked = receipt.expenses.reduce((n, e) => n + e.amountSen, 0)
      if (booked + payload.entries.reduce((n, e) => n + e.amountSen, 0) > r.totalSen) throw conflict('agent:TOTAL_MISMATCH')
      const owner = await tx.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
      if (!owner) throw conflict('agent:NO_OWNER')
      const expenseIds: string[] = []
      for (const entry of payload.entries) expenseIds.push((await createExpense(tx, request.businessId, owner.id, entry, { receiptDocumentId: receipt.id })).id)
      const result = { status: 'accepted', submissionId, receiptKey: payload.receiptKey, expenseIds, receipt: linkOf(receipt) }
      await tx.chopperSubmission.create({ data: { businessId: request.businessId, submissionId, kind: 'submit', receiptKey: payload.receiptKey, digest: hash, result, agentUserId: request.agentUser!.id } })
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'chopper.receipt.booked', entityType: 'receipt', entityId: receipt.id, detail: result } })
      return result
    })
  } catch (error) {
    // Two identical submits racing: the unique (business, submissionId) lets one in; the other reads its result.
    if (isUniqueViolation(error)) { const won = await stored(request.db, submissionId, hash); if (won) return won }
    throw error
  }
}

export async function agentChopperRoutes(app: FastifyInstance) {
  const write = { preHandler: requireAgent('BOOKKEEPER') }
  const read = { preHandler: requireAgent('VIEWER') }

  app.get<{ Params: { submissionId: string } }>('/agent/chopper/submissions/:submissionId', read, async request => {
    const submissionId = z.string().uuid().parse(request.params.submissionId)
    const prior = await request.db.chopperSubmission.findFirst({ where: { submissionId } })
    if (!prior) return { status: 'none', submissionId, expenseIds: [], receipt: null }
    const result = prior.result as { expenseIds: string[] }
    const receipt = await receiptByKey(request.db, prior.receiptKey)
    return { status: 'accepted', submissionId, kind: prior.kind, receiptKey: prior.receiptKey, expenseIds: result.expenseIds, receipt: receipt ? linkOf(receipt) : null, acceptedAt: prior.createdAt.toISOString() }
  })

  app.get('/agent/chopper/duplicates', read, async request => {
    const q = z.object({
      receiptNo: z.string().trim().max(60).optional(), date: DATE.optional(), totalSen: z.coerce.number().int().positive().optional(),
      sha256: SHA.optional(), receiptKey: KEY.optional(),
    }).parse(request.query)
    const byInvoice = Boolean(q.receiptNo), byDateTotal = Boolean(q.date && q.totalSen), byImage = Boolean(q.sha256)
    if (!byInvoice && !byDateTotal && !byImage) throw badRequest('validation:INVALID_REQUEST', 'give receiptNo, date+totalSen or sha256')
    const day = q.date ? new Date(q.date + 'T00:00:00Z') : undefined
    const or: Prisma.ExpenseWhereInput[] = []
    if (byInvoice) or.push({ receiptNo: { equals: q.receiptNo, mode: 'insensitive' } }, { receiptDocument: { receiptNo: { equals: q.receiptNo, mode: 'insensitive' } } })
    if (byDateTotal) or.push({ businessDate: day, amountSen: q.totalSen }, { receiptDocument: { receiptDate: day, totalSen: q.totalSen } })
    if (byImage) or.push({ receiptDocument: { sha256: q.sha256 } })
    const rows = await request.db.expense.findMany({ where: { OR: or }, include: { receiptDocument: true }, orderBy: { businessDate: 'desc' }, take: 50 })
    const same = (a?: string | null, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
    return rows.map(e => {
      const doc = e.receiptDocument, reasons: string[] = []
      if (byInvoice && (same(e.receiptNo, q.receiptNo) || same(doc?.receiptNo, q.receiptNo))) reasons.push('invoice')
      if (byDateTotal && ((e.businessDate.getTime() === day!.getTime() && e.amountSen === q.totalSen) || (doc?.receiptDate?.getTime() === day!.getTime() && doc?.totalSen === q.totalSen))) reasons.push('date+total')
      if (byImage && doc?.sha256 === q.sha256) reasons.push('image')
      const receiptKey = doc ? keyOf(doc) : null
      return { expenseId: e.id, receiptKey, date: e.businessDate.toISOString().slice(0, 10), amountSen: e.amountSen, vendor: e.vendor ?? doc?.vendor ?? null, description: e.description, reasons, sameReceiptKey: Boolean(q.receiptKey && receiptKey === q.receiptKey) }
    })
  })

  app.post('/agent/chopper/link/preview', write, async request => {
    const body = linkBody.parse(request.body)
    body.expenseIds = [...new Set(body.expenseIds)].sort()
    await verifyScan(request, body.driveFileId, body.sha256)
    const receipt = await receiptByKey(request.db, body.receiptKey)
    if (receipt && receipt.sha256 !== body.sha256) throw conflict('agent:DUPLICATE_EVIDENCE', 'this receipt key is booked with a different scan')
    const expenses = await linkable(request.db, body, receipt?.id)
    const until = Date.now() + PREVIEW_MS, data = Buffer.from(JSON.stringify({ until, body })).toString('base64url')
    return { previewToken: `${data}.${sign([request.businessId, data])}`, previewHash: digest(body), expenses, expiresAt: new Date(until).toISOString() }
  })

  app.post('/agent/chopper/link', write, async request => {
    const { previewToken, submissionId } = z.object({ previewToken: z.string().max(8000), submissionId: z.string().uuid() }).parse(request.body)
    const [data = '', mac = ''] = previewToken.split('.')
    if (!sameHex(mac, sign([request.businessId, data]))) throw conflict('agent:PREVIEW_STALE')
    const { until, body } = JSON.parse(Buffer.from(data, 'base64url').toString()) as { until: number; body: LinkBody }
    const hash = digest(body)
    const prior = await stored(request.db, submissionId, hash)
    if (prior) return prior
    if (until < Date.now()) throw conflict('agent:PREVIEW_STALE')
    const file = await verifyScan(request, body.driveFileId, body.sha256)
    try {
      return await request.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + body.receiptKey}))::text`
        const again = await stored(tx, submissionId, hash)
        if (again) return again
        let receipt = await receiptByKey(tx, body.receiptKey)
        if (receipt && receipt.sha256 !== body.sha256) throw conflict('agent:DUPLICATE_EVIDENCE', 'this receipt key is booked with a different scan')
        const expenses = await linkable(tx, body, receipt?.id)
        if (!receipt) {
          const sameImage = await tx.receiptDocument.findFirst({ where: { sha256: body.sha256 } })
          if (sameImage) throw conflict('agent:DUPLICATE_EVIDENCE', keyOf(sameImage))
          const first = expenses[0]!
          await tx.receiptDocument.create({ data: {
            id: randomUUID(), businessId: request.businessId, receiptKey: body.receiptKey, status: 'LINKED', sha256: body.sha256,
            mimeType: file.mimeType, driveFileId: file.id, driveUrl: file.webViewLink ?? null, scanDriveFileId: file.id, scanDriveUrl: file.webViewLink ?? null,
            fileName: body.fileName, drivePath: body.drivePath, vendor: first.vendor, receiptDate: new Date(first.date + 'T00:00:00Z'), receiptNo: first.receiptNo,
            uploadedById: request.agentUser!.id, resolvedAt: new Date(),
            extracted: { _chopper: { linked: true, key: body.receiptKey }, _inbox: { originalRetired: true } },
          } })
          receipt = (await receiptByKey(tx, body.receiptKey))!
        }
        // Link metadata only: amounts, dates and the cash book are untouched.
        await tx.expense.updateMany({ where: { id: { in: body.expenseIds } }, data: { receiptDocumentId: receipt.id } })
        const result = { status: 'accepted', submissionId, receiptKey: body.receiptKey, expenseIds: body.expenseIds, receipt: linkOf(receipt) }
        await tx.chopperSubmission.create({ data: { businessId: request.businessId, submissionId, kind: 'link', receiptKey: body.receiptKey, digest: hash, result, agentUserId: request.agentUser!.id } })
        await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'chopper.receipt.linked', entityType: 'receipt', entityId: receipt.id, detail: result } })
        return result
      })
    } catch (error) {
      if (isUniqueViolation(error)) { const won = await stored(request.db, submissionId, hash); if (won) return won }
      throw error
    }
  })

  app.post<{ Params: { receiptKey: string } }>('/agent/chopper/receipts/:receiptKey/filed', write, async request => {
    const key = KEY.parse(request.params.receiptKey)
    const body = z.object(fileLink).parse(request.body)
    const receipt = await receiptByKey(request.db, key)
    if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
    // Moving keeps the file ID; a different ID is accepted only if it is the very same image.
    const file = await verifyScan(request, body.driveFileId, receipt.sha256)
    const updated = await request.db.receiptDocument.update({ where: { id: receipt.id }, data: {
      driveFileId: file.id, scanDriveFileId: file.id, driveUrl: file.webViewLink ?? null, scanDriveUrl: file.webViewLink ?? null,
      fileName: body.fileName, drivePath: body.drivePath, ...(receipt.receiptKey ? {} : { receiptKey: key }),
    } })
    return { receiptKey: key, expenseIds: receipt.expenses.map(e => e.id), receipt: linkOf(updated) }
  })
}

/** Expenses that may take this scan: all in this business, none already backed by a different receipt. */
async function linkable(db: Tx, body: LinkBody, receiptId: string | undefined) {
  const rows = await db.expense.findMany({ where: { id: { in: body.expenseIds } }, orderBy: { businessDate: 'asc' } })
  if (rows.length !== body.expenseIds.length) throw notFound('rms:EXPENSE_NOT_FOUND')
  const taken = rows.find(e => e.receiptDocumentId && e.receiptDocumentId !== receiptId)
  if (taken) throw conflict('agent:EXPENSE_HAS_RECEIPT', taken.id)
  return rows.map(e => ({ expenseId: e.id, date: e.businessDate.toISOString().slice(0, 10), amountSen: e.amountSen, vendor: e.vendor, receiptNo: e.receiptNo, description: e.description }))
}
