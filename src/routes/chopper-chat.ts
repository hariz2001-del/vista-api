import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent, requireOwner } from '../auth.ts'
import type { Tx } from '../db.ts'
import { badRequest, notFound } from '../errors.ts'

/**
 * Chatting with Chopper from the RMS, and handing it receipt photos.
 *
 * The owner's message or photo waits here; Chopper's relay on the VPS claims it.
 * A question goes to Hermes in one ongoing conversation; a photo goes straight
 * into Chopper's receipt pipeline (the same one as Telegram), and Chopper posts a
 * card back once it has read it. /bulk, /endbulk and /stash are answered here at
 * once, from Vista's copy of the stash. Vista never calls the VPS: the relay polls.
 */

const STALE_MS = 10 * 60_000
// Vercel takes request bodies up to 4.5 MB; a file travels as base64 (a third larger).
const MAX_FILE = 3 * 1024 * 1024
const ID = z.string().regex(/^\d{1,18}$/)
const IMAGE = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/

type Row = { id: bigint; role: string; text: string; status: string; kind: string; batch: string | null; receiptKey: string | null; fileName: string | null; fileMime: string | null; replyTo: bigint | null; createdAt: Date }
const view = (m: Row) => ({
  id: m.id.toString(),
  role: m.role,
  text: m.text,
  status: m.status,
  kind: m.kind,
  batch: m.batch,
  receiptKey: m.receiptKey,
  file: m.fileName ? { name: m.fileName, mime: m.fileMime ?? 'application/octet-stream' } : null,
  replyTo: m.replyTo?.toString() ?? null,
  createdAt: m.createdAt.toISOString(),
})
const select = { id: true, role: true, text: true, status: true, kind: true, batch: true, receiptKey: true, fileName: true, fileMime: true, replyTo: true, createdAt: true } as const

/** What Chopper has made of photos: the stash's view of each, by receipt key. */
async function receiptStates(db: Tx, keys: string[]) {
  if (!keys.length) return {}
  const rows = await db.chopperStash.findMany({ where: { receiptKey: { in: keys } }, select: { receiptKey: true, data: true } })
  return Object.fromEntries(rows.map((row) => {
    const d = row.data as { state?: string; reading?: { vendor?: string; date?: string; totalSen?: number } | null; problem?: string | null; warning?: string | null; recorded?: boolean; duplicates?: number; stashDuplicates?: string[] }
    return [row.receiptKey, {
      state: d.state ?? 'PROCESSING', vendor: d.reading?.vendor ?? null, date: d.reading?.date ?? null, totalSen: d.reading?.totalSen ?? null,
      problem: d.problem ?? null, warning: d.warning ?? null, recorded: Boolean(d.recorded), duplicate: Boolean(d.duplicates || d.stashDuplicates?.length),
    }]
  }))
}

export async function chopperChatRoutes(app: FastifyInstance) {
  const owner = { preHandler: requireOwner }
  const relay = { preHandler: requireAgent('BOOKKEEPER') }

  /** The conversation (photos from Expenses are not part of it): the latest 60, then only what is new. */
  app.get('/rms/chopper/chat', owner, async (request) => {
    const { after } = z.object({ after: ID.optional() }).parse(request.query)
    const notUploads = { kind: { not: 'upload' } }
    const rows = after
      ? await request.db.chopperChatMessage.findMany({ where: { id: { gt: BigInt(after) }, ...notUploads }, orderBy: { id: 'asc' }, take: 100, select })
      : (await request.db.chopperChatMessage.findMany({ where: notUploads, orderBy: { id: 'desc' }, take: 60, select })).reverse()
    // Messages already on screen change too (working → answered, a photo's receipt key).
    const open = await request.db.chopperChatMessage.findMany({ where: { role: 'owner', status: { in: ['PENDING', 'WORKING'] }, ...notUploads }, select })
    const recent = await request.db.chopperChatMessage.findMany({ where: { kind: 'receipt', receiptKey: { not: null } }, orderBy: { id: 'desc' }, take: 60, select })
    return { messages: rows.map(view), open: open.map(view), receipts: recent.map(view) }
  })

  /** A message, or a command answered at once from Vista's copy of the stash. */
  app.post('/rms/chopper/chat', owner, async (request) => {
    const { text, batch } = z.object({ text: z.string().trim().min(1).max(4000), batch: z.string().uuid().optional() }).parse(request.body)
    const { db, businessId } = request
    const command = text.toLowerCase().split(/\s+/)[0]
    if (command === '/bulk' || command === '/endbulk' || command === '/stash') {
      const asked = await db.chopperChatMessage.create({ data: { businessId, role: 'owner', text, status: 'ANSWERED', kind: 'text' }, select })
      if (command === '/bulk') {
        const id = randomUUID()
        const reply = await db.chopperChatMessage.create({ data: { businessId, role: 'chopper', status: 'DONE', kind: 'text', batch: id, replyTo: asked.id,
          text: 'Bulk on. Drop or pick as many photos as you like — I read them quietly. Send /endbulk when you are done.' }, select })
        return { messages: [view(asked), view(reply)], batch: id }
      }
      if (command === '/endbulk') {
        const count = batch ? await db.chopperChatMessage.count({ where: { kind: 'receipt', batch } }) : 0
        const reply = await db.chopperChatMessage.create({ data: { businessId, role: 'chopper', status: 'DONE', kind: 'batch', batch: batch ?? null, replyTo: asked.id,
          text: count ? `Bulk off. ${count} receipt${count === 1 ? '' : 's'} from this run:` : 'Bulk off. No photos came in this run.' }, select })
        return { messages: [view(asked), view(reply)], batch: null }
      }
      const open = await db.chopperStash.count({ where: { status: 'OPEN' } })
      const reply = await db.chopperChatMessage.create({ data: { businessId, role: 'chopper', status: 'DONE', kind: 'stash', replyTo: asked.id,
        text: open ? 'In the stash:' : 'The stash is empty.' }, select })
      return { messages: [view(asked), view(reply)] }
    }
    const row = await db.chopperChatMessage.create({ data: { businessId, role: 'owner', text }, select })
    return { messages: [view(row)] }
  })

  /** A receipt photo for Chopper to read: from the chat ("chat") or from Expenses ("expenses"). */
  app.post('/rms/chopper/receipts', { ...owner, bodyLimit: 4_400_000 }, async (request) => {
    const body = z.object({
      name: z.string().trim().min(1).max(200),
      mime: z.string().regex(IMAGE),
      base64: z.string().min(1),
      source: z.enum(['chat', 'expenses']),
      batch: z.string().uuid().optional(),
    }).parse(request.body)
    const bytes = Buffer.from(body.base64, 'base64')
    if (!bytes.length || bytes.length > MAX_FILE) throw badRequest('validation:INVALID_REQUEST', 'a photo up to 3 MB')
    const row = await request.db.chopperChatMessage.create({ data: {
      businessId: request.businessId, role: 'owner', text: '', kind: body.source === 'chat' ? 'receipt' : 'upload',
      batch: body.batch ?? null, fileName: body.name, fileMime: body.mime, fileBytes: bytes,
    }, select })
    return view(row)
  })

  /** Where photos stand: waiting, being read, or read (with what Chopper made of them). */
  app.get('/rms/chopper/receipts', owner, async (request) => {
    const { ids, batch } = z.object({ ids: z.string().regex(/^\d{1,18}(,\d{1,18}){0,99}$/).optional(), batch: z.string().uuid().optional() }).parse(request.query)
    if (!ids && !batch) return { receipts: [] }
    const rows = await request.db.chopperChatMessage.findMany({
      where: { kind: { in: ['receipt', 'upload'] }, ...(ids ? { id: { in: ids.split(',').map(BigInt) } } : { batch }) },
      orderBy: { id: 'asc' }, take: 200, select,
    })
    const states = await receiptStates(request.db, rows.flatMap((r) => (r.receiptKey ? [r.receiptKey] : [])))
    return { receipts: rows.map((r) => ({ ...view(r), receipt: r.receiptKey ? (states[r.receiptKey] ?? null) : null })) }
  })

  /** The stash as a list for the chat's /stash card. */
  app.get('/rms/chopper/stash-list', owner, async (request) => {
    const rows = await request.db.chopperStash.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 50, select: { receiptKey: true } })
    const states = await receiptStates(request.db, rows.map((r) => r.receiptKey))
    return { receipts: rows.map((r) => ({ receiptKey: r.receiptKey, ...states[r.receiptKey] })) }
  })

  app.get<{ Params: { id: string } }>('/rms/chopper/chat/:id/file', owner, async (request, reply) => {
    const id = BigInt(ID.parse(request.params.id))
    const row = await request.db.chopperChatMessage.findFirst({ where: { id }, select: { fileName: true, fileMime: true, fileBytes: true } })
    if (!row?.fileBytes || !row.fileName) throw notFound('agent:CHAT_FILE_NOT_FOUND')
    return reply
      .header('content-type', row.fileMime ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${row.fileName.replace(/"/g, '')}"`)
      .header('access-control-expose-headers', 'content-disposition')
      .header('cache-control', 'private, max-age=3600')
      .send(Buffer.from(row.fileBytes))
  })

  // ── Chopper's relay ────────────────────────────────────────────────────────

  /** The oldest waiting message or photo (or one a crashed relay left behind). Photos first: they are quick. */
  app.post('/agent/chopper/chat/claim', relay, async (request) => {
    const stale = new Date(Date.now() - STALE_MS)
    const taken = await request.db.$transaction(async (tx) => {
      const waiting = { role: 'owner', OR: [{ status: 'PENDING' }, { status: 'WORKING', claimedAt: { lt: stale } }] }
      const next = (await tx.chopperChatMessage.findFirst({ where: { ...waiting, kind: { in: ['receipt', 'upload'] } }, orderBy: { id: 'asc' }, select }))
        ?? (await tx.chopperChatMessage.findFirst({ where: { ...waiting, kind: 'text' }, orderBy: { id: 'asc' }, select }))
      if (!next) return null
      const claimed = await tx.chopperChatMessage.updateMany({ where: { id: next.id, status: next.status }, data: { status: 'WORKING', claimedAt: new Date() } })
      return claimed.count === 1 ? next : null
    })
    return { message: taken ? view(taken) : null }
  })

  app.get<{ Params: { id: string } }>('/agent/chopper/chat/:id/file', relay, async (request, reply) => {
    const id = BigInt(ID.parse(request.params.id))
    const row = await request.db.chopperChatMessage.findFirst({ where: { id }, select: { fileMime: true, fileBytes: true } })
    if (!row?.fileBytes) throw notFound('agent:CHAT_FILE_NOT_FOUND')
    return reply.header('content-type', row.fileMime ?? 'application/octet-stream').send(Buffer.from(row.fileBytes))
  })

  /** A photo is in Chopper's pipeline as this receipt. */
  app.post<{ Params: { id: string } }>('/agent/chopper/chat/:id/received', relay, async (request) => {
    const id = BigInt(ID.parse(request.params.id))
    const { receiptKey, failed, text } = z.object({ receiptKey: z.string().regex(/^R-[0-9A-F]{6}$/).optional(), failed: z.boolean().default(false), text: z.string().max(500).optional() }).parse(request.body)
    await request.db.chopperChatMessage.updateMany({ where: { id, kind: { in: ['receipt', 'upload'] } }, data: { status: failed ? 'FAILED' : 'ANSWERED', receiptKey: receiptKey ?? null, ...(text ? { text } : {}) } })
    return { ok: true }
  })

  /** Chopper's card for a photo it has read in the chat (not in a /bulk run, not from Expenses). */
  app.post('/agent/chopper/chat/card', relay, async (request) => {
    const body = z.object({ replyTo: ID, receiptKey: z.string().regex(/^R-[0-9A-F]{6}$/), text: z.string().max(4000) }).parse(request.body)
    const asked = await request.db.chopperChatMessage.findFirst({ where: { id: BigInt(body.replyTo), kind: 'receipt' } })
    if (!asked) throw notFound('agent:CHAT_MESSAGE_NOT_FOUND')
    if (asked.batch) return { ok: true, quiet: true }
    // One card per photo: a re-read updates it rather than adding another.
    const prior = await request.db.chopperChatMessage.findFirst({ where: { replyTo: asked.id, kind: 'card' } })
    if (prior) await request.db.chopperChatMessage.update({ where: { id: prior.id }, data: { text: body.text } })
    else await request.db.chopperChatMessage.create({ data: { businessId: request.businessId, role: 'chopper', status: 'DONE', kind: 'card', receiptKey: body.receiptKey, replyTo: asked.id, text: body.text } })
    return { ok: true, quiet: false }
  })

  app.post<{ Params: { id: string } }>('/agent/chopper/chat/:id/reply', { ...relay, bodyLimit: 4_400_000 }, async (request) => {
    const id = BigInt(ID.parse(request.params.id))
    const body = z.object({
      text: z.string().max(20_000),
      failed: z.boolean().default(false),
      files: z.array(z.object({ name: z.string().trim().min(1).max(200), mime: z.string().max(100), base64: z.string() })).max(3).default([]),
    }).parse(request.body)
    return request.db.$transaction(async (tx) => {
      const asked = await tx.chopperChatMessage.findFirst({ where: { id, role: 'owner' } })
      if (!asked) throw notFound('agent:CHAT_MESSAGE_NOT_FOUND')
      // A repeated reply (a lost answer, retried) is not posted twice.
      if (asked.status === 'ANSWERED' || asked.status === 'FAILED') return { ok: true, repeated: true }
      const files = body.files.map((f) => ({ ...f, bytes: Buffer.from(f.base64, 'base64') }))
      if (files.some((f) => f.bytes.length > MAX_FILE)) throw badRequest('validation:INVALID_REQUEST', 'file over 3 MB')
      const text = body.text.trim() || (files.length ? '' : '(no answer)')
      await tx.chopperChatMessage.create({ data: { businessId: request.businessId, role: 'chopper', text, status: 'DONE', replyTo: id, ...(files[0] ? { fileName: files[0].name, fileMime: files[0].mime, fileBytes: files[0].bytes } : {}) } })
      for (const f of files.slice(1)) await tx.chopperChatMessage.create({ data: { businessId: request.businessId, role: 'chopper', text: '', status: 'DONE', replyTo: id, fileName: f.name, fileMime: f.mime, fileBytes: f.bytes } })
      await tx.chopperChatMessage.update({ where: { id }, data: { status: body.failed ? 'FAILED' : 'ANSWERED' } })
      return { ok: true, repeated: false }
    })
  })
}
