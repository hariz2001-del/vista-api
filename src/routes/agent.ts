import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { hashAgentKey, newAgentKey, requireAgent, requireOwner } from '../auth.ts'
import type { Tx } from '../db.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { driveConfigured, fileByDate, readFromDrive, storeReceiptImage } from '../integrations/drive.ts'
import { createExpense, expenseBody, previewExpense } from './rms.ts'
import { receiptScan } from '../integrations/receipt-scan.ts'
import { sameVendor } from '../receipt-matching.ts'

/**
 * Sarang AI — the bookkeeping agent (a Hermes profile on Telegram).
 *
 *  - /rms/agent/*  The owner makes agent keys and lists who may use the agent.
 *  - /agent/*      The agent itself: a receipt inbox, the options its buttons
 *                  offer, and posting confirmed receipts into the books.
 *
 * The agent never writes the books on its own terms: posting goes through
 * `createExpense`, the same path as the RMS form, and only after the person
 * has seen the exact preview (its token must still match).
 */

const ID = z.string().uuid()
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const TELEGRAM_ID = z.string().regex(/^\d{1,20}$/)

/** Vercel refuses request bodies over 4.5 MB; base64 adds a third. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

const CATEGORY_LABELS: Record<string, string> = {
  RAW_MATERIALS: 'Stock / ingredients',
  PACKAGING: 'Packaging & disposables',
  ICE_GAS: 'Ice & gas',
  RENT: 'Rent',
  UTILITIES: 'Utilities',
  OPERATIONS: 'Cleaning & operations',
  MAINTENANCE: 'Maintenance & repairs',
  CAPITAL_ASSET: 'Equipment',
}

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  DUITNOW_QR: 'DuitNow QR',
  DEBIT_CARD: 'Debit card',
  BANK_TRANSFER: 'Bank transfer',
}

async function act(
  tx: Tx,
  request: FastifyRequest,
  action: string,
  entityType: string,
  entityId: string,
  detail?: unknown,
): Promise<void> {
  await tx.agentAction.create({
    data: {
      businessId: request.businessId,
      agentUserId: request.agentUser?.id ?? null,
      action,
      entityType,
      entityId,
      detail: detail === undefined ? undefined : JSON.parse(JSON.stringify(detail)),
    },
  })
}

/** The account owner: expenses Sarang AI posts are logged under them. */
async function ownerUserId(tx: Tx): Promise<string> {
  const owner = await tx.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
  if (!owner) throw conflict('agent:NO_OWNER')
  return owner.id
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null
}

type ReceiptRow = Awaited<ReturnType<Tx['receiptDocument']['findUniqueOrThrow']>>

function serialiseReceipt(receipt: ReceiptRow & { expenses?: Array<{ id: string; amountSen: number; description: string; brandId: string | null }> }) {
  return {
    id: receipt.id,
    ref: `R-${receipt.id.slice(0, 6).toUpperCase()}`,
    status: receipt.status,
    vendor: receipt.vendor,
    receiptDate: iso(receipt.receiptDate),
    receiptNo: receipt.receiptNo,
    totalSen: receipt.totalSen,
    extracted: receipt.extracted,
    reviewFlags: receipt.reviewFlags,
    notes: receipt.notes,
    mimeType: receipt.mimeType,
    inDrive: Boolean(receipt.driveFileId),
    driveUrl: receipt.driveUrl,
    scanDriveUrl: receipt.scanDriveUrl,
    hasScan: Boolean(receipt.scanDriveFileId || (receipt.extracted && typeof receipt.extracted === 'object' && 'scan' in receipt.extracted)),
    createdAt: receipt.createdAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
    expenses: receipt.expenses?.map((expense) => ({
      id: expense.id,
      amountSen: expense.amountSen,
      description: expense.description,
      brandId: expense.brandId,
    })),
  }
}

async function requireReceipt(tx: Tx, id: string) {
  const receipt = await tx.receiptDocument.findUnique({
    where: { id },
    include: { expenses: { select: { id: true, amountSen: true, description: true, brandId: true } } },
  })
  if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
  return receipt
}

const OPEN_STATUSES = ['UPLOADED', 'PENDING_REVIEW', 'SKIPPED'] as const

function assertOpen(receipt: { status: string }, append = false): void {
  if (append && ['POSTED', 'LINKED'].includes(receipt.status)) return
  if (!(OPEN_STATUSES as readonly string[]).includes(receipt.status)) throw conflict('agent:RECEIPT_DONE')
}

/** A fingerprint of exactly what a preview showed, so a post can prove it is the same. */
function previewToken(receipt: { id: string; updatedAt: Date }, entries: unknown): string {
  return createHash('sha256').update(JSON.stringify([receipt.id, receipt.updatedAt.toISOString(), entries])).digest('hex').slice(0, 32)
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const keyBody = z.object({ label: z.string().trim().min(1).max(60) })
const userBody = z.object({
  telegramUserId: TELEGRAM_ID,
  name: z.string().trim().min(1).max(60),
  role: z.enum(['OWNER', 'BOOKKEEPER', 'VIEWER']),
})
const userUpdate = z
  .object({ name: z.string().trim().min(1).max(60), role: z.enum(['OWNER', 'BOOKKEEPER', 'VIEWER']), isActive: z.boolean() })
  .partial()

const uploadBody = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']).default('image/jpeg'),
  telegramChatId: TELEGRAM_ID.or(z.string().regex(/^-\d{1,20}$/)).optional(),
  telegramMessageId: z.string().regex(/^\d{1,20}$/).optional(),
  note: z.string().trim().max(500).optional(),
  deferProcessing: z.boolean().default(false),
})

const extractionBody = z.object({
  onlyMissing: z.boolean().default(false),
  vendor: z.string().trim().max(120).nullish(),
  receiptDate: DATE.nullish(),
  receiptNo: z.string().trim().max(60).nullish(),
  totalSen: z.number().int().min(0).max(100_000_000).nullish(),
  /** Lines, tax, discount, payment and per-field confidence — kept as read. */
  extracted: z.record(z.string(), z.unknown()).nullish(),
  reviewFlags: z.array(z.string().max(400)).max(20).optional(),
})

const listQuery = z.object({
  status: z.enum(['UPLOADED', 'PENDING_REVIEW', 'POSTED', 'LINKED', 'SKIPPED', 'REJECTED', 'OPEN']).default('OPEN'),
  order: z.enum(['oldest', 'newest', 'random']).default('oldest'),
  limit: z.coerce.number().int().min(1).max(50).default(5),
})

const entriesBody = z.object({
  entries: z.array(expenseBody).min(1).max(10),
  append: z.boolean().default(false),
})
const postBody = entriesBody.extend({
  previewToken: z.string().min(1),
  /** The person accepted that the entries differ from the receipt's total. */
  allowTotalMismatch: z.boolean().default(false),
})
const linkBody = z.object({ expenseIds: z.array(ID).min(1).max(10) })
const reasonBody = z.object({ reason: z.string().trim().max(300).optional() })

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // RMS: keys and who may use the agent (owner only)
  // -------------------------------------------------------------------------

  app.get('/rms/agent', { preHandler: requireOwner }, async (request) => {
    const [keys, users, open] = await Promise.all([
      request.db.agentKey.findMany({ orderBy: { createdAt: 'desc' } }),
      request.db.agentUser.findMany({ orderBy: { createdAt: 'asc' } }),
      request.db.receiptDocument.count({ where: { status: { in: ['UPLOADED', 'PENDING_REVIEW', 'SKIPPED'] } } }),
    ])
    return {
      keys: keys.map((key) => ({
        id: key.id,
        label: key.label,
        createdAt: key.createdAt.toISOString(),
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        revokedAt: key.revokedAt?.toISOString() ?? null,
      })),
      users: users.map((user) => ({
        id: user.id,
        telegramUserId: user.telegramUserId.toString(),
        name: user.name,
        role: user.role,
        isActive: user.isActive,
      })),
      openReceipts: open,
    }
  })

  /** A new key, shown once: only its hash is kept. */
  app.post('/rms/agent/keys', { preHandler: requireOwner }, async (request) => {
    const { label } = keyBody.parse(request.body)
    const key = newAgentKey()
    const row = await request.db.agentKey.create({
      data: { businessId: request.businessId, label, keyHash: hashAgentKey(key) },
    })
    return { id: row.id, key }
  })

  app.post<{ Params: { id: string } }>('/rms/agent/keys/:id/revoke', { preHandler: requireOwner }, async (request) => {
    const id = ID.parse(request.params.id)
    const done = await request.db.agentKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } })
    if (done.count === 0 && !(await request.db.agentKey.findUnique({ where: { id } }))) throw notFound('agent:KEY_NOT_FOUND')
    return { ok: true }
  })

  app.post('/rms/agent/users', { preHandler: requireOwner }, async (request) => {
    const body = userBody.parse(request.body)
    const telegramUserId = BigInt(body.telegramUserId)
    if (await request.db.agentUser.findFirst({ where: { telegramUserId } })) throw conflict('agent:USER_EXISTS')
    const user = await request.db.agentUser.create({
      data: { businessId: request.businessId, telegramUserId, name: body.name, role: body.role },
    })
    return { id: user.id }
  })

  app.patch<{ Params: { id: string } }>('/rms/agent/users/:id', { preHandler: requireOwner }, async (request) => {
    const id = ID.parse(request.params.id)
    const body = userUpdate.parse(request.body)
    const done = await request.db.agentUser.updateMany({ where: { id }, data: body })
    if (done.count === 0) throw notFound('agent:USER_NOT_FOUND')
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Agent: who am I, and what the buttons offer
  // -------------------------------------------------------------------------

  app.get('/agent/me', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const settings = await request.db.accountSettings.findUnique({ where: { businessId: request.businessId } })
    return { business: settings?.businessName ?? 'Vista', user: request.agentUser }
  })

  /**
   * Everything the receipt buttons offer, read from this business's own set-up
   * so the agent never hard-codes a brand, category or split.
   */
  app.get('/agent/options', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const { db, businessId } = request
    const [brands, settings, partners] = await Promise.all([
      db.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.accountSettings.findUnique({ where: { businessId } }),
      db.partner.findMany(),
    ])
    const settlement = settings?.settlementEnabled ?? false
    const [first, second] = brands
    const partnerOf = (brandId: string | undefined) => partners.find((partner) => partner.brandId === brandId)?.name
    return {
      brands: brands.map((brand) => ({ id: brand.id, name: brand.name })),
      /** A shared expense is split between the first and second brand; this is the first brand's share. */
      split: settlement && first && second
        ? {
            firstBrand: first.name,
            secondBrand: second.name,
            overheadFirstPct: settings?.sharedOverheadFoodPct ?? 70,
            equipmentFirstPct: settings?.capitalAssetFoodPct ?? 50,
            rule: 'Equipment (CAPITAL_ASSET) defaults to equipmentFirstPct; every other category to overheadFirstPct. A per-expense override never changes the default.',
          }
        : null,
      categories: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
      paidBy: settlement
        ? [
            { value: 'STALL_FUNDS', label: 'Stall funds', hint: 'Counter bank account or till cash — leaves the stall cash book' },
            { value: 'PARTNER_FOOD', label: `${first?.name ?? 'First'} partner${partnerOf(first?.id) ? ` (${partnerOf(first?.id)})` : ''}`, hint: 'Out of their own pocket — a debt the stall owes them' },
            { value: 'PARTNER_DRINKS', label: `${second?.name ?? 'Second'} partner${partnerOf(second?.id) ? ` (${partnerOf(second?.id)})` : ''}`, hint: 'Out of their own pocket — a debt the stall owes them' },
          ]
        : [{ value: 'STALL_FUNDS', label: 'Stall funds', hint: 'The only option while partner settlement is off' }],
      paymentMethods: Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label })),
      expenseShape:
        'An entry is the RMS expense: { businessDate YYYY-MM-DD, amountSen int, category, paidBy, brandId (null = shared), foodSplitPct (first brand %, used only when shared), description, receiptNo?, vendor?, receiptTime? HH:MM, paymentMethod?, notes?, items?: [{ name, quantityMilli, unit?, unitPriceSen }] — items must sum to amountSen }.',
    }
  })

  // -------------------------------------------------------------------------
  // Receipts inbox
  // -------------------------------------------------------------------------

  /**
   * Keep a receipt photo: the same photo, or the same Telegram message, twice
   * is the same receipt. The image goes to Google Drive when Drive is set up,
   * and is held here until then.
   */
  app.post(
    '/agent/receipts',
    { preHandler: requireAgent('BOOKKEEPER'), bodyLimit: 6 * 1024 * 1024 },
    async (request) => {
      const body = uploadBody.parse(request.body)
      const bytes = Buffer.from(body.imageBase64, 'base64')
      if (bytes.length === 0) throw badRequest('validation:INVALID_REQUEST', 'empty image')
      if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('agent:IMAGE_TOO_LARGE')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const { db, businessId } = request
      const chatId = body.telegramChatId ? BigInt(body.telegramChatId) : null
      const messageId = body.telegramMessageId ? BigInt(body.telegramMessageId) : null

      const existing = await db.receiptDocument.findFirst({
        where: {
          OR: [
            { sha256 },
            ...(chatId !== null && messageId !== null ? [{ telegramChatId: chatId, telegramMessageId: messageId }] : []),
          ],
        },
        include: { expenses: { select: { id: true, amountSen: true, description: true, brandId: true } } },
      })
      if (existing) {
        const duplicateOf = typeof existing.extracted === 'object' && existing.extracted && 'duplicateOf' in existing.extracted ? existing.extracted.duplicateOf : null
        const canonicalId = typeof duplicateOf === 'string' ? duplicateOf : existing.id
        if (!body.deferProcessing) await storeReceiptImage(db, canonicalId).catch((error: unknown) => request.log.warn({ err: error, receiptId: canonicalId }, 'Receipt Drive retry failed'))
        const fresh = await requireReceipt(db, canonicalId)
        if (body.deferProcessing && ['UPLOADED', 'PENDING_REVIEW', 'SKIPPED'].includes(fresh.status)) await db.receiptJob.upsert({ where: { receiptId: fresh.id }, create: { businessId, receiptId: fresh.id }, update: {} })
        return { duplicate: true, duplicateReason: existing.sha256 === sha256 ? 'identical image bytes' : 'same Telegram message delivered again', receipt: serialiseReceipt(fresh), drive: fresh.driveFileId ? 'stored' : 'pending' }
      }

      const receipt = await db.$transaction(async (tx) => {
        const created = await tx.receiptDocument.create({
          data: {
            businessId,
            sha256,
            telegramChatId: chatId,
            telegramMessageId: messageId,
            mimeType: body.mimeType,
            notes: body.note ?? null,
            uploadedById: request.agentUser?.id ?? null,
            image: { create: { bytes } },
          },
        })
        await act(tx, request, 'receipt.uploaded', 'receipt', created.id, { sha256, size: bytes.length })
        if (body.deferProcessing) await tx.receiptJob.create({ data: { businessId, receiptId: created.id } })
        return created
      })

      // Drive is best effort here: a failure leaves the photo safe in the
      // database, and a later upload retries it.
      const drive = body.deferProcessing ? false : await storeReceiptImage(db, receipt.id).catch((error: unknown) => {
        request.log.warn({ err: error, receiptId: receipt.id }, 'Receipt Drive upload failed')
        return null
      })
      const fresh = await db.receiptDocument.findUniqueOrThrow({ where: { id: receipt.id } })
      return { duplicate: false, receipt: serialiseReceipt(fresh), drive: drive ? 'stored' : 'pending' }
    },
  )

  app.get('/agent/receipts', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const query = listQuery.parse(request.query)
    const where =
      query.status === 'OPEN'
        ? { status: { in: [...OPEN_STATUSES] } }
        : { status: query.status }
    const total = await request.db.receiptDocument.count({ where })
    let rows
    if (query.order === 'random') {
      const ids = await request.db.receiptDocument.findMany({ where, select: { id: true } })
      const picked = ids.toSorted(() => Math.random() - 0.5).slice(0, query.limit).map((row) => row.id)
      rows = await request.db.receiptDocument.findMany({ where: { id: { in: picked } } })
    } else {
      rows = await request.db.receiptDocument.findMany({
        where,
        orderBy: { createdAt: query.order === 'oldest' ? 'asc' : 'desc' },
        take: query.limit,
      })
    }
    return { total, receipts: rows.map((row) => serialiseReceipt(row)) }
  })

  app.get<{ Params: { id: string } }>('/agent/receipts/:id', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const id = ID.parse(request.params.id)
    await requireReceipt(request.db, id)
    await storeReceiptImage(request.db, id).catch((error: unknown) => request.log.warn({ err: error, receiptId: id }, 'Receipt Drive retry failed'))
    return { receipt: serialiseReceipt(await requireReceipt(request.db, id)) }
  })

  /** The photo itself, to show while sorting. */
  app.get<{ Params: { id: string } }>('/agent/receipts/:id/image', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const id = ID.parse(request.params.id)
    const receipt = await requireReceipt(request.db, id)
    const image = await request.db.receiptImage.findUnique({ where: { receiptId: id } })
    const original = z.object({ original: z.enum(['true', 'false']).optional() }).parse(request.query).original === 'true'
    const scanned = !original && (image?.scanBytes || receipt.scanDriveFileId)
    const bytes = scanned ? image?.scanBytes ? Buffer.from(image.scanBytes) : await readFromDrive(receipt.scanDriveFileId!) : image ? Buffer.from(image.bytes) : receipt.driveFileId ? await readFromDrive(receipt.driveFileId) : null
    return {
      mimeType: scanned ? 'image/jpeg' : receipt.mimeType,
      driveUrl: scanned ? receipt.scanDriveUrl : receipt.driveUrl,
      imageBase64: bytes ? bytes.toString('base64') : null,
    }
  })

  app.post<{ Params: { id: string } }>('/agent/receipts/:id/scan', { preHandler: requireAgent('BOOKKEEPER') }, async (request) => {
    const id = ID.parse(request.params.id)
    const body = z.object({ corners: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).length(4).optional() }).parse(request.body ?? {})
    const receipt = await requireReceipt(request.db, id)
    if (receipt.mimeType === 'application/pdf') throw badRequest('validation:INVALID_REQUEST')
    const image = await request.db.receiptImage.findUnique({ where: { receiptId: id } })
    const bytes = image ? Buffer.from(image.bytes) : receipt.driveFileId ? await readFromDrive(receipt.driveFileId) : null
    if (!bytes) throw notFound('agent:RECEIPT_NOT_FOUND')
    const scan = await receiptScan(bytes, body.corners)
    await request.db.receiptImage.upsert({ where: { receiptId: id }, create: { receiptId: id, businessId: request.businessId, bytes: new Uint8Array(bytes), scanBytes: new Uint8Array(scan) }, update: { scanBytes: new Uint8Array(scan) } })
    await request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const latest = await requireReceipt(tx, id)
      await tx.receiptDocument.update({ where: { id }, data: { extracted: JSON.parse(JSON.stringify({ ...(typeof latest.extracted === 'object' && latest.extracted ? latest.extracted : {}), scan: { corners: body.corners ?? null, madeAt: new Date().toISOString(), originalPreserved: true } })) } })
    })
    await act(request.db, request, 'receipt.scanned', 'receipt', id, { corners: body.corners, originalPreserved: true })
    let driveError: string | null = null
    try { await storeReceiptImage(request.db, id) } catch (error) { driveError = error instanceof Error ? error.message : 'Drive upload failed' }
    return { receipt: serialiseReceipt(await requireReceipt(request.db, id)), scanned: true, driveError }
  })

  /** What was read off the photo. Provisional until someone posts it. */
  app.patch<{ Params: { id: string } }>(
    '/agent/receipts/:id/extraction',
    { preHandler: requireAgent('BOOKKEEPER') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const body = extractionBody.parse(request.body)
      await request.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
        const receipt = await requireReceipt(tx, id)
        assertOpen(receipt)
        if (body.onlyMissing) {
          if (receipt.vendor !== null) delete body.vendor
          if (receipt.receiptDate !== null) delete body.receiptDate
          if (receipt.receiptNo !== null) delete body.receiptNo
          if (receipt.totalSen !== null) delete body.totalSen
          if (body.extracted) body.extracted = { ...body.extracted, ...(receipt.extracted as object) }
          if (body.reviewFlags) body.reviewFlags = [...new Set([...receipt.reviewFlags, ...body.reviewFlags])].slice(0, 20)
        }
        await tx.receiptDocument.update({
          where: { id },
          data: {
            ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
            ...(body.receiptDate !== undefined ? { receiptDate: body.receiptDate ? new Date(`${body.receiptDate}T00:00:00Z`) : null } : {}),
            ...(body.receiptNo !== undefined ? { receiptNo: body.receiptNo } : {}),
            ...(body.totalSen !== undefined ? { totalSen: body.totalSen } : {}),
            ...(body.extracted !== undefined ? { extracted: body.extracted === null ? Prisma.DbNull : JSON.parse(JSON.stringify({ ...(typeof receipt.extracted === 'object' && receipt.extracted ? receipt.extracted : {}), ...body.extracted })) } : {}),
            ...(body.reviewFlags ? { reviewFlags: body.reviewFlags } : {}),
            status: receipt.status === 'UPLOADED' ? 'PENDING_REVIEW' : receipt.status,
          },
        })
        await act(tx, request, 'receipt.read', 'receipt', id, body)
      })
      // Drive is best effort: a failure leaves the photo safe in the database.
      let driveError: string | null = null
      try {
        await storeReceiptImage(request.db, id)
        await fileByDate(request.db, id)
      } catch (error) {
        request.log.warn({ err: error, receiptId: id }, 'Receipt Drive filing failed')
        driveError = error instanceof Error ? error.message : 'Drive filing failed'
      }
      return { receipt: serialiseReceipt(await requireReceipt(request.db, id)), driveConfigured: driveConfigured(), driveError }
    },
  )

  /**
   * Expenses this receipt may already be in the books as: the same receipt
   * number, the same vendor near the date, or the same total (one row, or
   * several rows sharing a receipt number, as when a bill was split by brand).
   */
  app.get<{ Params: { id: string } }>('/agent/receipts/:id/matches', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const receipt = await requireReceipt(request.db, ID.parse(request.params.id))
    const around = receipt.receiptDate ?? receipt.createdAt
    const from = new Date(around.getTime() - 21 * 86_400_000)
    const to = new Date(around.getTime() + 21 * 86_400_000)
    const candidates = await request.db.expense.findMany({
      where: {
        OR: [
          ...(receipt.receiptNo ? [{ receiptNo: { equals: receipt.receiptNo, mode: 'insensitive' as const } }] : []),
          { businessDate: { gte: from, lte: to } },
        ],
      },
      select: {
        id: true,
        businessDate: true,
        amountSen: true,
        description: true,
        vendor: true,
        receiptNo: true,
        brandId: true,
        category: true,
        paidBy: true,
        receiptDocumentId: true,
      },
      take: 400,
    })
    const groups = new Map<string, number>()
    const groupKey = (row: typeof candidates[number]) => `${row.receiptNo?.toLowerCase()}|${row.vendor?.toLowerCase()}|${iso(row.businessDate)}`
    for (const row of candidates) if (row.receiptNo) groups.set(groupKey(row), (groups.get(groupKey(row)) ?? 0) + row.amountSen)
    const scored = candidates
      .map((row) => {
        const why: string[] = []
        let score = 0
        if (receipt.receiptNo && row.receiptNo?.toLowerCase() === receipt.receiptNo.toLowerCase()) {
          score += 4
          why.push('same receipt number')
        }
        if (sameVendor(receipt.vendor, row.vendor)) {
          score += 2
          why.push('same vendor')
        }
        if (receipt.totalSen !== null && row.amountSen === receipt.totalSen) {
          score += 3
          why.push('same amount')
        } else if (receipt.totalSen !== null && row.receiptNo && groups.get(groupKey(row)) === receipt.totalSen) {
          score += 3
          why.push('rows with this receipt number add up to the total')
        }
        if (receipt.receiptDate) {
          const days = Math.abs(row.businessDate.getTime() - receipt.receiptDate.getTime()) / 86_400_000
          if (days === 0) {
            score += 2
            why.push('same day')
          } else if (days <= 3) {
            score += 1
            why.push(`${days} day${days === 1 ? '' : 's'} apart`)
          }
        }
        return { row, score, why }
      })
      .filter((match) => match.score >= 3)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 10)
    return {
      matches: scored.map(({ row, score, why }) => ({
        expenseId: row.id,
        businessDate: iso(row.businessDate),
        amountSen: row.amountSen,
        description: row.description,
        vendor: row.vendor,
        receiptNo: row.receiptNo,
        brandId: row.brandId,
        category: row.category,
        paidBy: row.paidBy,
        alreadyHasReceipt: Boolean(row.receiptDocumentId),
        score,
        why,
      })),
    }
  })

  /**
   * Exactly what posting would write — each entry's brand split as the books
   * would snapshot it — and a token the post must bring back unchanged.
   */
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/preview', { preHandler: requireAgent('BOOKKEEPER') }, async (request) => {
    const id = ID.parse(request.params.id)
    const { entries, append } = entriesBody.parse(request.body)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      const receipt = await requireReceipt(tx, id)
      assertOpen(receipt, append)
      const brands = await tx.brand.findMany({ orderBy: { sortOrder: 'asc' } })
      const name = (brandId: string | null) => (brandId === null ? 'Shared' : (brands.find((b) => b.id === brandId)?.name ?? '?'))
      const rows = []
      for (const entry of entries) {
        const split = await previewExpense(tx, businessId, entry)
        rows.push({
          ...entry,
          brand: name(entry.brandId),
          [`${brands[0]?.name ?? 'first'}Sen`]: split.foodAmountSen,
          [`${brands[1]?.name ?? 'second'}Sen`]: split.drinksAmountSen,
          foodSplitPct: split.foodSplitPct,
        })
      }
      const sum = entries.reduce((total, entry) => total + entry.amountSen, 0)
      const allocatedSen = receipt.expenses.reduce((total, entry) => total + entry.amountSen, 0)
      return {
        receipt: serialiseReceipt(receipt),
        entries: rows,
        entriesTotalSen: sum,
        allocatedSen,
        remainingSen: receipt.totalSen === null ? null : receipt.totalSen - allocatedSen,
        combinedTotalSen: allocatedSen + sum,
        append,
        matchesReceiptTotal: receipt.totalSen === null ? null : allocatedSen + sum === receipt.totalSen,
        previewToken: previewToken(receipt, { entries, append }),
      }
    })
  })

  /** Post confirmed entries: all of them or none, once. */
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/post', { preHandler: requireAgent('BOOKKEEPER') }, async (request) => {
    const id = ID.parse(request.params.id)
    const body = postBody.parse(request.body)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      // One post at a time per receipt: a double tap waits, then finds it done.
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${businessId} FOR UPDATE`
      const receipt = await requireReceipt(tx, id)
      assertOpen(receipt, body.append)
      if (previewToken(receipt, { entries: body.entries, append: body.append }) !== body.previewToken) throw conflict('agent:PREVIEW_STALE')
      const sum = body.entries.reduce((total, entry) => total + entry.amountSen, 0) + receipt.expenses.reduce((total, entry) => total + entry.amountSen, 0)
      if (receipt.totalSen !== null && sum !== receipt.totalSen && !body.allowTotalMismatch) throw conflict('agent:TOTAL_MISMATCH')
      const createdById = await ownerUserId(tx)
      const ids: string[] = []
      for (const entry of body.entries) {
        const created = await createExpense(
          tx,
          businessId,
          createdById,
          { ...entry, vendor: entry.vendor ?? receipt.vendor, receiptNo: entry.receiptNo ?? receipt.receiptNo },
          { receiptDocumentId: id },
        )
        ids.push(created.id)
      }
      await tx.receiptDocument.update({ where: { id }, data: { status: 'POSTED', resolvedAt: new Date() } })
      await act(tx, request, 'receipt.posted', 'receipt', id, { expenseIds: ids, entries: body.entries })
      return { expenseIds: ids, receipt: serialiseReceipt(await requireReceipt(tx, id)) }
    })
  })

  /** Attach the receipt to expenses already in the books, instead of posting new ones. */
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/link', { preHandler: requireAgent('BOOKKEEPER') }, async (request) => {
    const id = ID.parse(request.params.id)
    const { expenseIds } = linkBody.parse(request.body)
    return request.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${request.businessId} FOR UPDATE`
      const receipt = await requireReceipt(tx, id)
      assertOpen(receipt, true)
      const expenses = await tx.expense.findMany({ where: { id: { in: expenseIds } } })
      if (expenses.length !== expenseIds.length) throw notFound('rms:EXPENSE_NOT_FOUND')
      if (expenses.some((expense) => expense.receiptDocumentId && expense.receiptDocumentId !== id)) {
        throw conflict('agent:EXPENSE_HAS_RECEIPT')
      }
      await tx.expense.updateMany({ where: { id: { in: expenseIds } }, data: { receiptDocumentId: id } })
      await tx.reconciliationCase.updateMany({ where: { key: { in: expenseIds.map(expenseId => `missing:${expenseId}`) }, kind: 'MISSING_RECEIPT', status: 'OPEN' }, data: { status: 'RESOLVED', resolution: `Receipt ${id} attached after user confirmation.` } })
      await tx.receiptDocument.update({ where: { id }, data: { status: 'LINKED', resolvedAt: new Date() } })
      await act(tx, request, 'receipt.linked', 'receipt', id, { expenseIds })
      return { receipt: serialiseReceipt(await requireReceipt(tx, id)) }
    })
  })

  for (const [path, status, action] of [
    ['skip', 'SKIPPED', 'receipt.skipped'],
    ['reject', 'REJECTED', 'receipt.rejected'],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/agent/receipts/:id/${path}`, { preHandler: requireAgent('BOOKKEEPER') }, async (request) => {
      const id = ID.parse(request.params.id)
      const { reason } = reasonBody.parse(request.body ?? {})
      return request.db.$transaction(async (tx) => {
        const receipt = await requireReceipt(tx, id)
        assertOpen(receipt)
        await tx.receiptDocument.update({
          where: { id },
          data: { status, ...(reason ? { notes: [receipt.notes, reason].filter(Boolean).join(' · ') } : {}) },
        })
        await act(tx, request, action, 'receipt', id, { reason })
        return { receipt: serialiseReceipt(await requireReceipt(tx, id)) }
      })
    })
  }
}
