import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { requireAgent, requireOwner } from '../auth.ts'
import type { Tx } from '../db.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { readFromDrive } from '../integrations/drive.ts'
import { pendingExpense, recordUncategorised, scrapFromPending, type ReadLine } from '../chopper/sorting.ts'
import {
  DATE, FILE_ID, KEY, SHA, bookReceipt, digest, isUniqueViolation, keyOf, normalise, receiptByKey, stored, suggestFor, verifyScan,
  type Booking, type StashData,
} from './agent-chopper.ts'
import { allocate, createExpense, expenseBody, settlementEnabled, syncCashLine } from './rms.ts'
import { lineTotalSen } from '../domain/expense-items.ts'

/**
 * Chopper's stash, shared with the RMS.
 *
 * Chopper reads a receipt and records it in Vista at once as a not-categorised
 * expense (see chopper/sorting.ts). It also mirrors its whole stash here after
 * every change, so the RMS can list it, show the scan, and sort the lines.
 * What the RMS sorts is queued for Chopper as events: Chopper applies them,
 * files the scan in Drive, tells the sender on Telegram, and acknowledges.
 * Lines are booked through the same exactly-once path from either side.
 */

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const LINE = z.object({ name: z.string().trim().min(1).max(200), quantityMilli: z.number().int().min(0).max(100_000_000), unitPriceSen: z.number().int().min(-10_000_000).max(100_000_000), amountSen: z.number().int().min(-10_000_000).max(100_000_000) })
const READING = z.object({
  vendor: z.string().trim().max(120).nullish(), date: DATE.nullish(), receiptNo: z.string().trim().max(60).nullish(),
  totalSen: z.number().int().nullish(), paymentMethod: z.string().max(30).nullish(), flags: z.array(z.string().max(300)).max(20).default([]),
  lines: z.array(LINE).max(200).default([]),
}).passthrough()
const DECISION = z.enum(['pending', 'posted', 'scrapped'])
const PAYMENT = z.enum(['CASH', 'DUITNOW_QR', 'DEBIT_CARD', 'BANK_TRANSFER'])

const stashItem = z.object({
  receiptKey: KEY,
  state: z.string().max(30),
  reading: READING.nullish(),
  decisions: z.array(DECISION).max(200).default([]),
  scanVerified: z.boolean().default(false),
  problem: z.string().max(400).nullish(),
  warning: z.string().max(400).nullish(),
  error: z.string().max(400).nullish(),
  duplicates: z.number().int().min(0).max(100).default(0),
  stashDuplicates: z.array(KEY).max(50).default([]),
  batch: z.string().max(80).nullish(),
  fileId: FILE_ID.nullish(),
  fileName: z.string().max(250).nullish(),
  drivePath: z.string().max(500).nullish(),
  sha256: SHA.nullish(),
  originalFileId: FILE_ID.nullish(),
  createdAt: z.number().nullish(),
})
type StashItem = z.infer<typeof stashItem>

const lineSum = (lines: ReadLine[]) => lines.reduce((n, l) => n + l.amountSen, 0)
const addsUp = (r: StashItem['reading']) => Boolean(r && r.totalSen != null && r.lines.length && lineSum(r.lines) === r.totalSen)

/** Merge what Chopper sent with what the RMS did that Chopper has not applied yet: a sorted line stays sorted. */
function merge(incoming: StashItem, current: StashData | null, unacked: boolean): StashData {
  // A reading corrected in the RMS stands until Chopper has taken it in.
  const keepReading = Boolean(unacked && current?.readingEditedAt && current.reading)
  const decisions = keepReading ? [...(current!.decisions ?? [])] : [...incoming.decisions]
  if (current?.decisions && unacked) current.decisions.forEach((d, i) => { if (d !== 'pending' && i < decisions.length) decisions[i] = d })
  return {
    ...incoming,
    ...(keepReading ? { reading: current!.reading, readingEditedAt: current!.readingEditedAt } : {}),
    decisions, allocations: current?.allocations ?? [], events: current?.events ?? [],
  } as StashData
}

/** The not-categorised expense follows a corrected reading while nothing is sorted. */
async function followReading(tx: Tx, key: string, reading: NonNullable<StashItem['reading']>, decisions: string[]) {
  const receipt = await receiptByKey(tx, key)
  if (!receipt) return
  const pending = await pendingExpense(tx, receipt.id)
  if (!pending || decisions.some(d => d !== 'pending') || receipt.expenses.some(e => !e.uncategorised)) return
  if (reading.totalSen == null || reading.totalSen <= 0 || !reading.date) return
  const same = pending.amountSen === reading.totalSen && pending.items.length === reading.lines.length
    && pending.items.every((item, i) => item.name === reading.lines[i]!.name && item.unitPriceSen === reading.lines[i]!.unitPriceSen && item.quantityMilli === reading.lines[i]!.quantityMilli)
    && pending.businessDate.toISOString().slice(0, 10) === reading.date
  if (same) return
  const owner = await tx.expense.findUniqueOrThrow({ where: { id: pending.id }, select: { createdById: true } })
  await tx.ledgerEntry.deleteMany({ where: { expenseId: pending.id } })
  await tx.expense.delete({ where: { id: pending.id } })
  await recordUncategorised(tx, {
    businessId: receipt.businessId, ownerId: owner.createdById, receiptDocumentId: receipt.id, date: reading.date,
    vendor: reading.vendor || 'Receipt', receiptNo: reading.receiptNo ?? null, totalSen: reading.totalSen,
    lines: reading.lines, paymentMethod: PAYMENT.safeParse(reading.paymentMethod).data ?? null, receiptKey: key,
  })
  await tx.receiptDocument.update({ where: { id: receipt.id }, data: { vendor: reading.vendor ?? receipt.vendor, totalSen: reading.totalSen, receiptDate: new Date(reading.date + 'T00:00:00Z'), receiptNo: reading.receiptNo ?? null } })
}

/** One stash row as the RMS lists it. */
function summary(row: { receiptKey: string; data: unknown; createdAt: Date; updatedAt: Date }) {
  const d = row.data as StashData & StashItem
  const r = d.reading, lines = r?.lines ?? [], decisions = d.decisions ?? []
  const pendingSen = lines.reduce((n, l, i) => n + (decisions[i] === 'pending' ? l.amountSen : 0), 0)
  const bookedSen = lines.reduce((n, l, i) => n + (decisions[i] === 'posted' ? l.amountSen : 0), 0)
  return {
    receiptKey: row.receiptKey, vendor: r?.vendor ?? null, date: r?.date ?? null, receiptNo: r?.receiptNo ?? null, totalSen: r?.totalSen ?? null,
    lineCount: lines.length, pendingSen, bookedSen, state: d.state,
    problem: d.problem ?? null, warning: d.warning ?? null, duplicate: Boolean(d.duplicates || d.stashDuplicates?.length),
    ready: Boolean(d.scanVerified && r && addsUp(r) && !d.problem), recorded: Boolean(d.recorded), receivedAt: row.createdAt.toISOString(),
    drivePath: d.drivePath ?? null, sortedAt: row.updatedAt.toISOString(),
  }
}

async function stashRow(db: Tx, key: string, anyStatus = false) {
  let row = await db.chopperStash.findFirst({ where: { receiptKey: key, ...(anyStatus ? {} : { status: 'OPEN' }) } })
  // A sorted receipt is read from the books: Chopper's copy stops once it is sorted (and older ones never had one).
  if (anyStatus && (!row || (row.status !== 'OPEN' && ((row.data as StashData).decisions ?? []).includes('pending')))) row = (await rowFromBooks(db, key, row)) ?? row
  if (!row) throw notFound('agent:STASH_NOT_FOUND')
  return row
}

/**
 * A receipt's lines as the books hold them: each expense's items, numbered as
 * receipt lines, booked ("posted") or not categorised ("pending"). A lump-sum
 * expense becomes one line of its own. Line numbers are written back onto the
 * items so later corrections find them.
 */
async function rowFromBooks(db: Tx, key: string, existing: Awaited<ReturnType<Tx['chopperStash']['findFirst']>>) {
  const doc = await receiptByKey(db, key)
  if (!doc) return null
  const expenses = await db.expense.findMany({ where: { receiptDocumentId: doc.id }, include: { items: { orderBy: { sortOrder: 'asc' } } }, orderBy: { createdAt: 'asc' } })
  if (!expenses.length) return null
  // Lump sums first become real items, so every line can be corrected like any other.
  for (const e of expenses) {
    if (e.items.length) continue
    e.items.push(await db.expenseItem.create({ data: { businessId: e.businessId, expenseId: e.id, name: e.description.slice(0, 120), quantityMilli: 1000, unitPriceSen: e.amountSen, totalSen: e.amountSen, sortOrder: 10_000 } }))
  }
  // Items keep their receipt line number when a receipt is split; renumber only where numbers clash (older bookings).
  const all = expenses.flatMap(e => e.items.map(item => ({ item, pending: e.uncategorised })))
  const clash = new Set(all.map(x => x.item.sortOrder)).size !== all.length
  all.sort((a, b) => clash ? 0 : a.item.sortOrder - b.item.sortOrder)
  const lines: ReadLine[] = []
  const decisions: Array<'pending' | 'posted' | 'scrapped'> = []
  for (const { item, pending } of all) {
    if (item.sortOrder !== lines.length) await db.expenseItem.update({ where: { id: item.id }, data: { sortOrder: lines.length } })
    lines.push({ name: item.name, quantityMilli: item.quantityMilli, unitPriceSen: item.unitPriceSen, amountSen: item.totalSen })
    decisions.push(pending ? 'pending' : 'posted')
  }
  const old = (existing?.data ?? {}) as StashData & StashItem
  const data = {
    ...old,
    receiptKey: key, state: 'SUBMITTED', scanVerified: true, recorded: true, duplicates: 0, stashDuplicates: [], fromBooks: true,
    fileId: doc.scanDriveFileId ?? doc.driveFileId, fileName: doc.fileName, drivePath: doc.drivePath, sha256: doc.sha256,
    reading: { vendor: doc.vendor ?? expenses[0]!.vendor, date: (doc.receiptDate ?? expenses[0]!.businessDate).toISOString().slice(0, 10), receiptNo: doc.receiptNo ?? expenses[0]!.receiptNo, totalSen: doc.totalSen ?? lineSum(lines), flags: [], lines },
    decisions,
  }
  return existing
    ? db.chopperStash.update({ where: { id: existing.id }, data: { data: json(data) } })
    : db.chopperStash.create({ data: { businessId: expenses[0]!.businessId, receiptKey: key, telegramUser: 'rms', status: 'DONE', data: json(data) } })
}

export async function chopperStashRoutes(app: FastifyInstance) {
  const bookkeeper = { preHandler: requireAgent('BOOKKEEPER') }
  const owner = { preHandler: requireOwner }

  // ── Chopper ────────────────────────────────────────────────────────────────

  /** Record a freshly read receipt as a not-categorised expense. Once per receipt key. */
  app.post('/agent/chopper/record', bookkeeper, async (request) => {
    const body = z.object({
      receiptKey: KEY,
      receipt: z.object({ vendor: z.string().trim().min(1).max(120), date: DATE, receiptNo: z.string().trim().max(60).nullish().transform(v => v || null), totalSen: z.number().int().positive(), sha256: SHA, driveFileId: FILE_ID, fileName: z.string().trim().min(1).max(250), drivePath: z.string().trim().min(1).max(500) }),
      lines: z.array(LINE).max(200).default([]),
      paymentMethod: PAYMENT.nullish(),
    }).parse(request.body)
    const file = await verifyScan(request, body.receipt.driveFileId, body.receipt.sha256)
    const r = body.receipt
    return request.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + body.receiptKey}))::text`
      let receipt = await receiptByKey(tx, body.receiptKey)
      if (receipt?.expenses.length) {
        const pending = receipt.expenses.find(e => e.uncategorised)
        return { recorded: true, alreadyRecorded: true, receiptKey: body.receiptKey, expenseId: pending?.id ?? null }
      }
      // Already in Vista under another key: leave it in the stash for a person to decide.
      if (r.receiptNo) {
        const twin = await tx.receiptDocument.findFirst({ where: { OR: [{ receiptKey: { not: body.receiptKey } }, { receiptKey: null }], vendor: { equals: r.vendor, mode: 'insensitive' }, receiptNo: { equals: r.receiptNo, mode: 'insensitive' }, receiptDate: new Date(r.date + 'T00:00:00Z'), totalSen: r.totalSen, expenses: { some: {} } } })
        if (twin) throw conflict('agent:DUPLICATE_INVOICE', keyOf(twin))
      }
      if (!receipt) {
        const sameImage = await tx.receiptDocument.findFirst({ where: { sha256: r.sha256 } })
        if (sameImage) throw conflict('agent:DUPLICATE_EVIDENCE', keyOf(sameImage))
        await tx.receiptDocument.create({ data: {
          id: randomUUID(), businessId: request.businessId, receiptKey: body.receiptKey, status: 'POSTED', sha256: r.sha256,
          mimeType: file.mimeType, driveFileId: file.id, driveUrl: file.webViewLink ?? null, scanDriveFileId: file.id, scanDriveUrl: file.webViewLink ?? null,
          fileName: r.fileName, drivePath: r.drivePath, vendor: r.vendor, receiptDate: new Date(r.date + 'T00:00:00Z'), receiptNo: r.receiptNo, totalSen: r.totalSen,
          uploadedById: request.agentUser!.id, resolvedAt: new Date(),
          extracted: { _chopper: { sealed: true, key: body.receiptKey, recorded: true }, _inbox: { originalRetired: true } },
        } })
        receipt = (await receiptByKey(tx, body.receiptKey))!
      }
      const firstOwner = await tx.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
      if (!firstOwner) throw conflict('agent:NO_OWNER')
      const made = await recordUncategorised(tx, {
        businessId: request.businessId, ownerId: firstOwner.id, receiptDocumentId: receipt.id, date: r.date, vendor: r.vendor,
        receiptNo: r.receiptNo, totalSen: r.totalSen, lines: body.lines, paymentMethod: body.paymentMethod ?? null, receiptKey: body.receiptKey,
      })
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'chopper.receipt.recorded', entityType: 'receipt', entityId: receipt.id, detail: json({ receiptKey: body.receiptKey, expenseId: made.id, totalSen: r.totalSen }) } })
      return { recorded: true, alreadyRecorded: false, receiptKey: body.receiptKey, expenseId: made.id }
    })
  })

  /** Lines scrapped on Telegram come off the not-categorised expense. Repeating it is harmless. */
  app.post('/agent/chopper/scrap', bookkeeper, async (request) => {
    const body = z.object({ receiptKey: KEY, lines: z.array(z.number().int().min(0).max(199)).min(1).max(200), amountSen: z.number().int().min(0) }).parse(request.body)
    return request.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + body.receiptKey}))::text`
      return scrapLines(tx, request.businessId, body.receiptKey, body.lines, body.amountSen, 'chopper')
    })
  })

  /** Chopper's whole stash, after every change. Receipts it no longer holds are closed here. */
  app.put('/agent/chopper/stash', bookkeeper, async (request) => {
    const body = z.object({ receipts: z.array(stashItem).max(500) }).parse(request.body)
    const telegramUser = String(request.agentUser!.telegramUserId)
    const keys = body.receipts.map(r => r.receiptKey)
    await request.db.$transaction(async (tx) => {
      for (const item of body.receipts) {
        const current = await tx.chopperStash.findFirst({ where: { receiptKey: item.receiptKey } })
        const unacked = Boolean(current && current.vistaRevision > current.ackedRevision)
        const data = merge(item, (current?.data as StashData) ?? null, unacked)
        const receipt = await receiptByKey(tx, item.receiptKey)
        ;(data as Record<string, unknown>).recorded = Boolean(receipt?.expenses.some(e => e.uncategorised) || receipt?.expenses.length)
        if (current) await tx.chopperStash.update({ where: { id: current.id }, data: { data: json(data), status: 'OPEN', telegramUser } })
        else await tx.chopperStash.create({ data: { businessId: request.businessId, receiptKey: item.receiptKey, telegramUser, data: json(data) } })
        if (item.reading && !unacked) await followReading(tx, item.receiptKey, item.reading, data.decisions ?? [])
      }
      // Closed only once Chopper has caught up with the RMS on it.
      const stale = await tx.chopperStash.findMany({ where: { status: 'OPEN', telegramUser, receiptKey: { notIn: keys } } })
      for (const row of stale) if (row.vistaRevision <= row.ackedRevision) await tx.chopperStash.update({ where: { id: row.id }, data: { status: 'DONE' } })
    }, { timeout: 30_000 })
    return { ok: true, open: keys.length }
  })

  /** What the RMS sorted that Chopper has not applied yet. */
  app.get('/agent/chopper/stash/events', bookkeeper, async (request) => {
    const rows = await request.db.$queryRaw<Array<{ receipt_key: string }>>`
      SELECT receipt_key FROM chopper_stash WHERE business_id = ${request.businessId} AND vista_revision > acked_revision ORDER BY updated_at LIMIT 50`
    const out = []
    for (const { receipt_key } of rows) {
      const row = await request.db.chopperStash.findFirst({ where: { receiptKey: receipt_key } })
      if (!row) continue
      const d = row.data as StashData
      out.push({ receiptKey: row.receiptKey, telegramUser: row.telegramUser, vistaRevision: row.vistaRevision, decisions: d.decisions ?? [], allocations: d.allocations ?? [], events: d.events ?? [] })
    }
    return { events: out }
  })

  app.post<{ Params: { key: string } }>('/agent/chopper/stash/:key/ack', bookkeeper, async (request) => {
    const key = KEY.parse(request.params.key)
    const { vistaRevision } = z.object({ vistaRevision: z.number().int().min(0) }).parse(request.body)
    const row = await request.db.chopperStash.findFirst({ where: { receiptKey: key } })
    if (!row) throw notFound('agent:STASH_NOT_FOUND')
    const acked = Math.min(Math.max(row.ackedRevision, vistaRevision), row.vistaRevision)
    const caughtUp = acked === row.vistaRevision
    await request.db.chopperStash.update({ where: { id: row.id }, data: { ackedRevision: acked, ...(caughtUp ? { data: json({ ...(row.data as StashData), events: [] }) } : {}) } })
    return { ok: true, ackedRevision: acked }
  })

  // ── Duplicates: the same receipt twice, from any channel ───────────────────

  /** What a stashed receipt looks like a duplicate of: booked receipts, hand-typed expenses, or another stashed photo. */
  app.get<{ Params: { key: string } }>('/rms/stash/:key/duplicates', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    return { others: await findDuplicates(request.db, key) }
  })

  /** The scan behind any receipt Vista knows by key (booked or stashed), for comparing. */
  app.get<{ Params: { key: string } }>('/rms/receipts/:key/scan', owner, async (request, reply) => {
    const key = KEY.parse(request.params.key)
    const doc = await receiptByKey(request.db, key)
    const stash = doc ? null : await request.db.chopperStash.findFirst({ where: { receiptKey: key } })
    const fileId = doc?.scanDriveFileId ?? doc?.driveFileId ?? (stash?.data as StashItem | undefined)?.fileId
    if (!fileId) throw notFound('agent:RECEIPT_IMAGE_MISSING')
    let bytes: Buffer
    try { bytes = await readFromDrive(fileId) } catch { throw notFound('agent:RECEIPT_IMAGE_MISSING') }
    return reply.header('content-type', bytes.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : 'image/jpeg').header('cache-control', 'private, max-age=600').send(bytes)
  })

  /** Settle a suspected duplicate from the RMS; Chopper is told, and files or retires the photos. */
  app.post<{ Params: { key: string } }>('/rms/stash/:key/duplicate', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const body = resolution.parse(request.body)
    return request.db.$transaction((tx) => resolveDuplicate(tx, request, key, body, 'rms'), { timeout: 30_000 })
  })

  app.get<{ Params: { key: string } }>('/agent/chopper/stash/:key/duplicates', bookkeeper, async (request) => {
    const key = KEY.parse(request.params.key)
    return { others: await findDuplicates(request.db, key) }
  })

  /** The scan behind a receipt Vista knows, for Chopper to show beside a suspected duplicate. */
  app.get<{ Params: { key: string } }>('/agent/chopper/receipts/:key/scan', bookkeeper, async (request, reply) => {
    const key = KEY.parse(request.params.key)
    const doc = await receiptByKey(request.db, key)
    const stash = doc ? null : await request.db.chopperStash.findFirst({ where: { receiptKey: key } })
    const fileId = doc?.scanDriveFileId ?? doc?.driveFileId ?? (stash?.data as StashItem | undefined)?.fileId
    if (!fileId) throw notFound('agent:RECEIPT_IMAGE_MISSING')
    return reply.header('content-type', 'application/octet-stream').send(await readFromDrive(fileId))
  })

  /** The same, from Telegram: Chopper has the photos in hand and does its part itself. */
  app.post<{ Params: { key: string } }>('/agent/chopper/stash/:key/duplicate', bookkeeper, async (request) => {
    const key = KEY.parse(request.params.key)
    const body = resolution.parse(request.body)
    return request.db.$transaction((tx) => resolveDuplicate(tx, request, key, body, 'chopper'), { timeout: 30_000 })
  })

  // ── RMS ────────────────────────────────────────────────────────────────────

  app.get('/rms/stash', owner, async (request) => {
    const { sorted } = z.object({ sorted: z.enum(['1']).optional() }).parse(request.query)
    const open = await request.db.chopperStash.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 300 })
    const toSort = open.map(summary).filter(r => r.lineCount === 0 || r.pendingSen > 0 || r.state === 'NEEDS_REVIEW' || r.state === 'PROCESSING')
    if (!sorted) return { receipts: toSort, count: toSort.length }
    const docs = await request.db.receiptDocument.findMany({
      where: { expenses: { some: { uncategorised: false } } },
      include: { expenses: { select: { amountSen: true, uncategorised: true, vendor: true, businessDate: true, _count: { select: { items: true } } } } },
      orderBy: [{ receiptDate: 'desc' }, { createdAt: 'desc' }], take: 300,
    })
    const list = docs.map(doc => {
      const booked = doc.expenses.filter(e => !e.uncategorised), waiting = doc.expenses.filter(e => e.uncategorised)
      return {
        receiptKey: keyOf(doc), vendor: doc.vendor ?? booked[0]?.vendor ?? null,
        date: (doc.receiptDate ?? booked[0]?.businessDate)?.toISOString().slice(0, 10) ?? null, receiptNo: doc.receiptNo, totalSen: doc.totalSen,
        lineCount: doc.expenses.reduce((n, e) => n + Math.max(1, e._count.items), 0),
        pendingSen: waiting.reduce((n, e) => n + e.amountSen, 0), bookedSen: booked.reduce((n, e) => n + e.amountSen, 0),
        state: 'SUBMITTED', problem: null, warning: null, duplicate: false, ready: true, recorded: true,
        receivedAt: doc.createdAt.toISOString(), drivePath: doc.drivePath, sortedAt: doc.updatedAt.toISOString(),
      }
    })
    return { receipts: list, count: toSort.length }
  })

  app.get<{ Params: { key: string } }>('/rms/stash/:key', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const row = await stashRow(request.db, key, true)
    const d = row.data as StashData & StashItem
    const lines = d.reading?.lines ?? []
    const receipt = await receiptByKey(request.db, key)
    const expenses = receipt ? (await request.db.expense.findMany({ where: { receiptDocumentId: receipt.id }, include: { items: { select: { sortOrder: true } } }, orderBy: { createdAt: 'asc' } }))
      .map(e => ({ id: e.id, amountSen: e.amountSen, brandId: e.brandId, category: e.category, uncategorised: e.uncategorised, description: e.description, paidBy: e.paidBy, paymentMethod: e.paymentMethod, foodSplitPct: e.foodSplitPct, isLocked: e.isLocked, lines: e.items.map(i => i.sortOrder) })) : []
    const pendingNames = lines.filter((_, i) => (d.decisions ?? [])[i] === 'pending').map(l => ({ name: l.name }))
    const suggestion = pendingNames.length ? await suggestFor(request.db, { vendor: d.reading?.vendor, lines: pendingNames }) : null
    return {
      ...summary(row),
      lines: lines.map((l, i) => ({ index: i, ...l, decision: (d.decisions ?? [])[i] ?? 'pending' })),
      allocations: d.allocations ?? [],
      expenses,
      sorted: row.status !== 'OPEN' || (d.decisions ?? []).every(x => x !== 'pending'),
      guess: suggestion?.overall ?? null,
      hasOriginal: Boolean(d.originalFileId),
      revision: row.vistaRevision,
    }
  })

  /** The scan Chopper filed (or the original photo), straight from Drive. */
  /** A small preview of the scan, for the receipt browser. Cached by the browser for an hour. */
  app.get<{ Params: { key: string } }>('/rms/stash/:key/thumb', owner, async (request, reply) => {
    const key = KEY.parse(request.params.key)
    const row = await stashRow(request.db, key, true)
    const id = (row.data as StashItem).fileId ?? (row.data as StashItem).originalFileId
    if (!id) throw notFound('agent:RECEIPT_IMAGE_MISSING')
    let bytes: Buffer
    try { bytes = await readFromDrive(id) } catch { throw notFound('agent:RECEIPT_IMAGE_MISSING') }
    if (bytes.subarray(0, 4).toString() === '%PDF') throw notFound('agent:RECEIPT_IMAGE_MISSING', 'a PDF has no preview')
    const { default: sharp } = await import('sharp')
    const small = await sharp(bytes).rotate().resize({ width: 360, height: 480, fit: 'cover', position: 'top' }).jpeg({ quality: 72 }).toBuffer()
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').send(small)
  })

  app.get<{ Params: { key: string } }>('/rms/stash/:key/scan', owner, async (request, reply) => {
    const key = KEY.parse(request.params.key)
    const original = z.object({ original: z.enum(['1', 'true']).optional() }).parse(request.query).original !== undefined
    const row = await stashRow(request.db, key, true)
    const d = row.data as StashItem
    const id = original ? d.originalFileId : d.fileId
    if (!id) throw notFound('agent:RECEIPT_IMAGE_MISSING')
    let bytes: Buffer
    try { bytes = await readFromDrive(id) } catch { throw notFound('agent:RECEIPT_IMAGE_MISSING') }
    const mime = bytes.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : bytes.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : 'image/jpeg'
    return reply.header('content-type', mime).header('cache-control', 'private, no-store').send(bytes)
  })

  /**
   * Put a receipt Chopper held back (a likely duplicate, a total to check) into
   * the books anyway, as not categorised. The owner looked and decided.
   */
  app.post<{ Params: { key: string } }>('/rms/stash/:key/record', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const row = await stashRow(request.db, key, true)
    const d = row.data as StashData & StashItem
    const rd = d.reading
    if (!d.fileId || !d.sha256 || !d.fileName || !d.drivePath) throw conflict('agent:SCAN_NOT_READY')
    if (!rd?.vendor || !rd.date || !rd.totalSen || rd.totalSen <= 0) throw conflict('agent:LINES_DO_NOT_ADD_UP', 'the shop, date and total are needed — tap Edit to fill them in')
    const file = await verifyScan(request, d.fileId, d.sha256)
    const head = { vendor: rd.vendor, date: rd.date, totalSen: rd.totalSen }
    const lines = (rd.lines ?? []).filter((_, i) => (d.decisions ?? [])[i] !== 'scrapped') as ReadLine[]
    return request.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + key}))::text`
      let receipt = await receiptByKey(tx, key)
      if (receipt?.expenses.length) return { recorded: true, alreadyRecorded: true }
      if (!receipt) {
        await tx.receiptDocument.create({ data: {
          id: randomUUID(), businessId: request.businessId, receiptKey: key, status: 'POSTED', sha256: d.sha256!,
          mimeType: file.mimeType, driveFileId: file.id, driveUrl: file.webViewLink ?? null, scanDriveFileId: file.id, scanDriveUrl: file.webViewLink ?? null,
          fileName: d.fileName!, drivePath: d.drivePath!, vendor: head.vendor, receiptDate: new Date(head.date + 'T00:00:00Z'), receiptNo: rd.receiptNo ?? null, totalSen: head.totalSen,
          resolvedAt: new Date(), extracted: { _chopper: { sealed: true, key, recorded: true, byOwner: true }, _inbox: { originalRetired: true } },
        } })
        receipt = (await receiptByKey(tx, key))!
      }
      await recordUncategorised(tx, {
        businessId: request.businessId, ownerId: request.user.id, receiptDocumentId: receipt.id, date: head.date, vendor: head.vendor,
        receiptNo: rd.receiptNo ?? null, totalSen: head.totalSen, lines, paymentMethod: PAYMENT.safeParse(rd.paymentMethod).data ?? null, receiptKey: key,
      })
      await tx.chopperStash.update({ where: { id: row.id }, data: { data: json({ ...d, recorded: true }) } })
      return { recorded: true, alreadyRecorded: false }
    })
  })

  /** Sort lines into a categorised expense, from the RMS. */
  app.post<{ Params: { key: string } }>('/rms/stash/:key/book', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const body = z.object({
      submissionId: z.string().uuid(),
      lines: z.array(z.number().int().min(0).max(199)).min(1).max(200),
      expectedSen: z.number().int().positive(),
      brandId: z.string().uuid().nullable(),
      category: expenseBody.shape.category,
      paidBy: expenseBody.shape.paidBy,
      paymentMethod: PAYMENT.nullable(),
      foodSplitPct: z.number().int().min(0).max(100),
    }).parse(request.body)
    const row = await stashRow(request.db, key)
    const d = row.data as StashData & StashItem
    const rd = d.reading
    if (!d.scanVerified || !d.fileId || !d.sha256 || !d.fileName || !d.drivePath) throw conflict('agent:SCAN_NOT_READY')
    if (!rd || !rd.vendor || !rd.date || rd.totalSen == null || !addsUp(rd)) throw conflict('agent:LINES_DO_NOT_ADD_UP')
    const picked = [...new Set(body.lines)].sort((a, b) => a - b)
    if (picked.some(i => i >= rd.lines.length)) throw badRequest('validation:INVALID_REQUEST')
    const chosen = picked.map(i => rd.lines[i]!)
    const amountSen = lineSum(chosen)
    if (amountSen !== body.expectedSen) throw conflict('agent:STASH_CHANGED')
    const payload: Booking = normalise({
      receiptKey: key, submissionId: body.submissionId, lines: picked,
      entries: [expenseBody.parse({
        businessDate: rd.date, amountSen, category: body.category, paidBy: body.paidBy, brandId: body.brandId, foodSplitPct: body.foodSplitPct,
        description: chosen.map(l => l.name).join('; ').slice(0, 200), vendor: rd.vendor, receiptNo: rd.receiptNo ?? null, paymentMethod: body.paymentMethod,
        notes: `Sorted in the RMS · ${key}`,
        items: chosen.filter(l => l.amountSen).map(l => ({ name: l.name.slice(0, 120), quantityMilli: l.quantityMilli, unitPriceSen: l.unitPriceSen })),
      })],
      receipt: { vendor: rd.vendor, date: rd.date, receiptNo: rd.receiptNo ?? null, totalSen: rd.totalSen, sha256: d.sha256, driveFileId: d.fileId, fileName: d.fileName, drivePath: d.drivePath },
    })
    const hash = digest(payload)
    const prior = await stored(request.db, body.submissionId, hash)
    if (prior) return prior
    const file = await verifyScan(request, d.fileId, d.sha256)
    try {
      return await request.db.$transaction(tx => bookReceipt(tx, { businessId: request.businessId, agentUserId: null, kind: 'rms', userId: request.user.id }, payload, file, hash), { timeout: 30_000 })
    } catch (error) {
      if (isUniqueViolation(error)) { const won = await stored(request.db, body.submissionId, hash); if (won) return won }
      throw error
    }
  })

  /** Leave lines out of the books, from the RMS. */
  app.post<{ Params: { key: string } }>('/rms/stash/:key/scrap', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const body = z.object({ lines: z.array(z.number().int().min(0).max(199)).min(1).max(200) }).parse(request.body)
    const row = await stashRow(request.db, key)
    const lines = (row.data as StashData).reading?.lines ?? []
    if (body.lines.some(i => i >= lines.length)) throw badRequest('validation:INVALID_REQUEST')
    const amountSen = body.lines.reduce((n, i) => n + lines[i]!.amountSen, 0)
    return request.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + key}))::text`
      return scrapLines(tx, request.businessId, key, body.lines, amountSen, 'rms')
    })
  })

  /** Re-categorise one booked part of a receipt: brand, category, who paid, how. Its lines stay as they are. */
  app.patch<{ Params: { key: string; id: string } }>('/rms/stash/:key/expenses/:id', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const id = z.string().uuid().parse(request.params.id)
    const body = z.object({
      brandId: z.string().uuid().nullable(),
      category: expenseBody.shape.category,
      paidBy: expenseBody.shape.paidBy,
      paymentMethod: PAYMENT.nullable(),
      foodSplitPct: z.number().int().min(0).max(100),
    }).parse(request.body)
    return request.db.$transaction(async (tx) => {
      const receipt = await receiptByKey(tx, key)
      const e = receipt ? await tx.expense.findFirst({ where: { id, receiptDocumentId: receipt.id } }) : null
      if (!e) throw notFound('rms:EXPENSE_NOT_FOUND')
      if (e.uncategorised) throw badRequest('validation:INVALID_REQUEST', 'sort it with Book first')
      if (e.isLocked) throw conflict('rms:PERIOD_LOCKED')
      if (e.paidBy !== 'STALL_FUNDS' && e.isSettled && body.paidBy !== e.paidBy) throw conflict('rms:EXPENSE_REIMBURSED')
      const withSettlement = await settlementEnabled(tx, request.businessId)
      if (!withSettlement && body.paidBy !== 'STALL_FUNDS') throw badRequest('rms:SETTLEMENT_OFF')
      const allocation = await allocate(tx, { brandId: body.brandId, amountSen: e.amountSen, foodSplitPct: body.foodSplitPct } as never, withSettlement)
      const updated = await tx.expense.update({ where: { id }, data: {
        brandId: body.brandId, category: body.category, paidBy: body.paidBy, paymentMethod: body.paymentMethod, ...allocation,
        isSettled: body.paidBy === 'STALL_FUNDS' || (e.isSettled && body.paidBy === e.paidBy),
      } })
      await syncCashLine(tx, request.businessId, e, updated)
      return { ok: true }
    })
  })

  /**
   * Correct a receipt's reading from the RMS: its title (shop, date, number,
   * total) and its lines. Booked lines change their expense in place; unsorted
   * ones change the not-categorised expense. Lines are corrected or added, never
   * removed ("Leave out" does that), so line numbers hold.
   */
  app.put<{ Params: { key: string } }>('/rms/stash/:key/reading', owner, async (request) => {
    const key = KEY.parse(request.params.key)
    const body = z.object({
      vendor: z.string().trim().min(1).max(120),
      date: DATE,
      receiptNo: z.string().trim().max(60).nullish().transform(v => v || null),
      totalSen: z.number().int().positive().max(100_000_000),
      lines: z.array(z.object({ name: z.string().trim().min(1).max(120), quantityMilli: z.number().int().positive().max(100_000_000), unitPriceSen: z.number().int().min(-10_000_000).max(100_000_000) })).min(1).max(200),
    }).parse(request.body)
    return request.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':chopper:' + key}))::text`
      const row = await stashRow(tx, key, true)
      const data = row.data as StashData & StashItem
      const before = data.reading?.lines ?? []
      if (body.lines.length < before.length) throw badRequest('validation:INVALID_REQUEST', 'lines can be corrected or added, not removed')
      const lines: ReadLine[] = body.lines.map(l => ({ ...l, amountSen: lineTotalSen(l.quantityMilli, l.unitPriceSen) }))
      const decisions = [...(data.decisions ?? [])]
      while (decisions.length < lines.length) decisions.push('pending')
      const receipt = await receiptByKey(tx, key)
      if (receipt) await carryReading(tx, request.businessId, request.user.id, receipt.id, key, body, lines, decisions)
      const reading = { ...(data.reading ?? {}), vendor: body.vendor, date: body.date, receiptNo: body.receiptNo, totalSen: body.totalSen, lines, flags: data.reading?.flags ?? [] }
      const events = [...(data.events ?? []), { type: 'reading', reading, decisions }]
      const warning = lineSum(lines) === body.totalSen ? null : `The lines add up to RM ${(lineSum(lines) / 100).toFixed(2)} but the total is RM ${(body.totalSen / 100).toFixed(2)}.`
      await tx.chopperStash.update({ where: { id: row.id }, data: { data: json({ ...data, reading, decisions, events, warning, readingEditedAt: new Date().toISOString() }), vistaRevision: { increment: 1 } } })
      return { ok: true, addsUp: warning === null }
    }, { timeout: 30_000 })
  })
}

/** Scrap lines: off the stash, and off the not-categorised expense. Lines already sorted are left alone. */
async function scrapLines(tx: Tx, businessId: string, key: string, lines: number[], amountSen: number, from: 'rms' | 'chopper') {
  const row = await tx.chopperStash.findFirst({ where: { receiptKey: key } })
  const data = (row?.data as StashData) ?? {}
  const decisions = [...(data.decisions ?? [])]
  const fresh = row ? lines.filter(i => decisions[i] === 'pending') : lines
  if (row && fresh.length === 0) return { ok: true, scrapped: [] }
  const readLines = data.reading?.lines ?? []
  const freshSen = row && readLines.length ? fresh.reduce((n, i) => n + (readLines[i]?.amountSen ?? 0), 0) : amountSen
  const receipt = await receiptByKey(tx, key)
  const pending = receipt ? await pendingExpense(tx, receipt.id) : null
  // Without a stash row, only lines still on the expense are taken (a repeat finds none).
  const onExpense = pending ? fresh.filter(i => pending.items.length === 0 || pending.items.some(item => item.sortOrder === i)) : []
  if (pending && onExpense.length) await scrapFromPending(tx, businessId, pending, onExpense, row ? freshSen : amountSen)
  if (row) {
    for (const i of fresh) decisions[i] = 'scrapped'
    const events = from === 'rms' ? [...(data.events ?? []), { type: 'scrapped', indices: fresh }] : data.events
    await tx.chopperStash.update({ where: { id: row.id }, data: { data: json({ ...data, decisions, events }), ...(from === 'rms' ? { vistaRevision: { increment: 1 } } : {}) } })
  }
  return { ok: true, scrapped: fresh }
}

/** A corrected reading, carried into the receipt's expenses: booked lines in place, unsorted ones on the not-categorised expense. */
async function carryReading(tx: Tx, businessId: string, userId: string, receiptDocumentId: string, key: string,
  head: { vendor: string; date: string; receiptNo: string | null; totalSen: number }, lines: ReadLine[], decisions: string[]) {
  const expenses = await tx.expense.findMany({ where: { receiptDocumentId }, include: { items: { orderBy: { sortOrder: 'asc' } } } })
  const withSettlement = await settlementEnabled(tx, businessId)
  for (const e of expenses) {
    if (e.isLocked) continue
    // Only expenses whose lines are the receipt's own numbered lines can follow them.
    const own = e.uncategorised
      ? lines.map((_, i) => i).filter(i => decisions[i] === 'pending')
      : e.items.length && e.items.every(item => item.sortOrder < lines.length && decisions[item.sortOrder] === 'posted') ? e.items.map(item => item.sortOrder) : null
    const items = own ? own.map(i => lines[i]!) : null
    const amountSen = items ? lineSum(items) : e.amountSen
    if (items && items.length === 0) {
      await syncCashLine(tx, businessId, e, null)
      await tx.expense.delete({ where: { id: e.id } })
      continue
    }
    const allocation = await allocate(tx, { brandId: e.brandId, amountSen, foodSplitPct: e.foodSplitPct } as never, withSettlement)
    const updated = await tx.expense.update({ where: { id: e.id }, data: {
      businessDate: new Date(head.date + 'T00:00:00Z'), vendor: head.vendor, receiptNo: head.receiptNo, amountSen, ...allocation,
      ...(e.uncategorised && items ? { description: ('Not categorised · ' + items.map(l => l.name).join('; ')).slice(0, 200) } : {}),
      ...(items ? { items: { deleteMany: {}, create: items.map((l, n) => ({ name: l.name, quantityMilli: l.quantityMilli, unitPriceSen: l.unitPriceSen, totalSen: l.amountSen, sortOrder: own![n]! })) } } : {}),
    } })
    await syncCashLine(tx, businessId, e, updated)
  }
  // A line added to a receipt in the books, with no not-categorised expense to carry it: a new one.
  const pendingIdx = lines.map((_, i) => i).filter(i => decisions[i] === 'pending')
  if (expenses.length && !expenses.some(e => e.uncategorised) && pendingIdx.length) {
    const pending = pendingIdx.map(i => lines[i]!)
    await createExpense(tx, businessId, userId, {
      businessDate: head.date, amountSen: lineSum(pending), category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: null, foodSplitPct: 50,
      description: ('Not categorised · ' + pending.map(l => l.name).join('; ')).slice(0, 200), receiptNo: head.receiptNo, vendor: head.vendor,
      receiptTime: null, paymentMethod: null, notes: `Added in the RMS · ${key}`,
      items: pending.map(l => ({ name: l.name, quantityMilli: l.quantityMilli, unit: null, unitPriceSen: l.unitPriceSen })),
    } as never, { receiptDocumentId, uncategorised: true, lineNumbers: pendingIdx })
  }
  await tx.receiptDocument.update({ where: { id: receiptDocumentId }, data: { vendor: head.vendor, receiptDate: new Date(head.date + 'T00:00:00Z'), receiptNo: head.receiptNo, totalSen: head.totalSen } })
}

const resolution = z.object({
  action: z.enum(['cancel', 'replace', 'keep']),
  /** The receipt it duplicates (booked or stashed), or the hand-typed expenses it belongs to. */
  otherKey: KEY.nullish(),
  expenseIds: z.array(z.string().uuid()).max(20).nullish(),
})

type Other = { kind: 'booked' | 'stash' | 'manual'; receiptKey: string | null; expenseIds: string[]; vendor: string | null; date: string | null; totalSen: number | null; reasons: string[]; hasScan: boolean }

/** Receipts or expenses this stashed receipt looks like: same invoice number, same day and total, or the same image. */
export async function findDuplicates(db: Tx, key: string): Promise<Other[]> {
  const row = await db.chopperStash.findFirst({ where: { receiptKey: key } })
  if (!row) throw notFound('agent:STASH_NOT_FOUND')
  const d = row.data as StashData & StashItem
  const rd = d.reading
  const day = rd?.date ? new Date(rd.date + 'T00:00:00Z') : null
  const or: Prisma.ExpenseWhereInput[] = []
  if (rd?.receiptNo) or.push({ receiptNo: { equals: rd.receiptNo, mode: 'insensitive' } }, { receiptDocument: { receiptNo: { equals: rd.receiptNo, mode: 'insensitive' } } })
  if (day && rd?.totalSen) or.push({ businessDate: day, amountSen: rd.totalSen }, { receiptDocument: { receiptDate: day, totalSen: rd.totalSen } })
  if (d.sha256) or.push({ receiptDocument: { sha256: d.sha256 } })
  // Keyed in by hand with no receipt: the same amount up to 3 days apart.
  if (day && rd?.totalSen) or.push({ receiptDocumentId: null, receiptUrl: null, uncategorised: false, amountSen: rd.totalSen, businessDate: { gte: new Date(day.getTime() - 3 * 86_400_000), lte: new Date(day.getTime() + 3 * 86_400_000) } })
  const others = new Map<string, Other>()
  if (or.length) {
    const rows = await db.expense.findMany({ where: { OR: or }, include: { receiptDocument: true }, take: 40, orderBy: { businessDate: 'desc' } })
    for (const e of rows) {
      const doc = e.receiptDocument
      const otherKey = doc ? keyOf(doc) : null
      if (otherKey === key) continue
      const id = otherKey ?? `manual:${e.id}`
      const reasons: string[] = []
      if (rd?.receiptNo && [e.receiptNo, doc?.receiptNo].some((n) => n && n.toLowerCase() === rd.receiptNo!.toLowerCase())) reasons.push('same receipt number')
      if (day && rd?.totalSen && ((e.businessDate.getTime() === day.getTime() && e.amountSen === rd.totalSen) || (doc?.receiptDate?.getTime() === day.getTime() && doc?.totalSen === rd.totalSen))) reasons.push('same day and total')
      if (d.sha256 && doc?.sha256 === d.sha256) reasons.push('the same photo')
      if (!doc && day && rd?.totalSen === e.amountSen && !reasons.length) {
        const apart = Math.round(Math.abs(e.businessDate.getTime() - day.getTime()) / 86_400_000)
        reasons.push(`same amount, ${apart} day${apart === 1 ? '' : 's'} apart`)
      }
      if (!doc && rd?.vendor && e.vendor && e.vendor.toLowerCase().slice(0, 5) === rd.vendor.toLowerCase().slice(0, 5)) reasons.push('same shop')
      const prior = others.get(id)
      if (prior) { prior.expenseIds.push(e.id); continue }
      others.set(id, {
        kind: doc ? 'booked' : 'manual', receiptKey: otherKey, expenseIds: [e.id], vendor: e.vendor ?? doc?.vendor ?? null,
        date: (doc?.receiptDate ?? e.businessDate).toISOString().slice(0, 10), totalSen: doc?.totalSen ?? e.amountSen, reasons,
        hasScan: Boolean(doc?.scanDriveFileId || doc?.driveFileId),
      })
    }
  }
  // Another photo of it still in the stash (sent twice, or from two channels).
  const stashed = await db.chopperStash.findMany({ where: { status: 'OPEN', receiptKey: { not: key } } })
  for (const other of stashed) {
    if (others.has(other.receiptKey)) continue
    const o = other.data as StashData & StashItem
    const od = o.reading
    const reasons: string[] = []
    if (d.sha256 && o.sha256 === d.sha256) reasons.push('the same photo')
    if (rd?.receiptNo && od?.receiptNo && rd.receiptNo.toLowerCase() === od.receiptNo.toLowerCase() && rd.date === od.date) reasons.push('same receipt number')
    if (rd?.date && rd.totalSen && od?.date === rd.date && od.totalSen === rd.totalSen && (od.vendor ?? '').toLowerCase().slice(0, 6) === (rd.vendor ?? '').toLowerCase().slice(0, 6)) reasons.push('same shop, day and total')
    if ((d.stashDuplicates ?? []).includes(other.receiptKey) && !reasons.length) reasons.push('Chopper flagged it')
    if (!reasons.length) continue
    others.set(other.receiptKey, { kind: 'stash', receiptKey: other.receiptKey, expenseIds: [], vendor: od?.vendor ?? null, date: od?.date ?? null, totalSen: od?.totalSen ?? null, reasons, hasScan: Boolean(o.fileId) })
  }
  return [...others.values()]
}

/** Every unsorted line of a receipt, left out: its not-categorised expense goes, its stash row says so. */
async function dropReceipt(tx: Tx, businessId: string, key: string, from: 'rms' | 'chopper') {
  const row = await tx.chopperStash.findFirst({ where: { receiptKey: key } })
  const lines = ((row?.data as StashData | undefined)?.decisions ?? []).map((x, i) => (x === 'pending' ? i : -1)).filter((i) => i >= 0)
  if (lines.length) await scrapLines(tx, businessId, key, lines, 0, from)
  // A receipt document with no expenses left only gets in the way of the photo's next use.
  await tx.receiptDocument.deleteMany({ where: { receiptKey: key, expenses: { none: {} } } })
}

async function resolveDuplicate(tx: Tx, request: FastifyRequest, key: string, body: z.infer<typeof resolution>, from: 'rms' | 'chopper') {
  const { businessId } = request
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':chopper:' + key}))::text`
  const row = await stashRow(tx, key, true)
  const d = row.data as StashData & StashItem
  let otherKind: Other['kind'] | null = null
  if (body.action === 'replace') {
    if (body.otherKey) otherKind = (await receiptByKey(tx, body.otherKey))?.expenses.some((e) => !e.uncategorised) ? 'booked' : 'stash'
    else if (body.expenseIds?.length) otherKind = 'manual'
    else throw badRequest('validation:INVALID_REQUEST', 'say which receipt it replaces')
  }
  const clean = { duplicates: 0, stashDuplicates: [], duplicateDismissed: true }
  let result: Record<string, unknown> = { action: body.action }

  if (body.action === 'keep') {
    await tx.chopperStash.update({ where: { id: row.id }, data: { data: json({ ...d, ...clean }) } })
  } else if (body.action === 'cancel') {
    await dropReceipt(tx, businessId, key, from)
  } else if (otherKind === 'stash') {
    // The new photo stays; the other stashed one goes.
    await dropReceipt(tx, businessId, body.otherKey!, from)
    await tx.chopperStash.update({ where: { id: row.id }, data: { data: json({ ...d, ...clean }) } })
  } else if (otherKind === 'booked') {
    // The booking stays; its photo becomes this one.
    if (!d.fileId || !d.sha256) throw conflict('agent:SCAN_NOT_READY')
    const file = await verifyScan(request, d.fileId, d.sha256)
    await dropReceipt(tx, businessId, key, from)
    const other = (await receiptByKey(tx, body.otherKey!))!
    await tx.receiptDocument.update({ where: { id: other.id }, data: {
      sha256: d.sha256, driveFileId: file.id, scanDriveFileId: file.id, driveUrl: file.webViewLink ?? null, scanDriveUrl: file.webViewLink ?? null,
      extracted: json({ ...((other as { extracted?: object }).extracted ?? {}), _replacedBy: key }),
    } })
    result = { ...result, otherKey: body.otherKey, oldFileId: other.scanDriveFileId ?? other.driveFileId, drivePath: other.drivePath, fileName: other.fileName }
  } else {
    // A hand-typed expense gets this photo as its receipt.
    if (!d.fileId || !d.sha256) throw conflict('agent:SCAN_NOT_READY')
    const file = await verifyScan(request, d.fileId, d.sha256)
    const expenses = await tx.expense.findMany({ where: { id: { in: body.expenseIds! } } })
    if (expenses.length !== body.expenseIds!.length || expenses.some((e) => e.receiptDocumentId)) throw conflict('agent:EXPENSE_HAS_RECEIPT')
    await dropReceipt(tx, businessId, key, from)
    const doc = await tx.receiptDocument.create({ data: {
      id: randomUUID(), businessId, receiptKey: key, status: 'LINKED', sha256: d.sha256, mimeType: file.mimeType, driveFileId: file.id, driveUrl: file.webViewLink ?? null,
      scanDriveFileId: file.id, scanDriveUrl: file.webViewLink ?? null, fileName: d.fileName ?? `${key}.jpg`, drivePath: d.drivePath ?? '', vendor: d.reading?.vendor ?? null,
      receiptDate: d.reading?.date ? new Date(d.reading.date + 'T00:00:00Z') : null, receiptNo: d.reading?.receiptNo ?? null, totalSen: d.reading?.totalSen ?? null,
      resolvedAt: new Date(), extracted: { _chopper: { linked: true, key }, _inbox: { originalRetired: true } },
    } })
    await tx.expense.updateMany({ where: { id: { in: body.expenseIds! } }, data: { receiptDocumentId: doc.id } })
    const fresh = (await stashRow(tx, key, true)).data as StashData
    await tx.chopperStash.update({ where: { id: row.id }, data: { data: json({ ...fresh, decisions: (fresh.decisions ?? []).map(() => 'posted'), linked: true }) } })
  }

  // The RMS settled it: Chopper hears, and moves or retires the photos.
  if (from === 'rms') {
    const now = (await stashRow(tx, key, true))
    const data = now.data as StashData
    await tx.chopperStash.update({ where: { id: now.id }, data: {
      data: json({ ...data, events: [...(data.events ?? []), { type: 'duplicate', ...result, otherKey: body.otherKey ?? null, otherKind }] }),
      vistaRevision: { increment: 1 },
    } })
  }
  return { ok: true, ...result, otherKind }
}
