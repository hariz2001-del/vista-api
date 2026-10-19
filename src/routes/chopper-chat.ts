import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent, requireOwner } from '../auth.ts'
import { badRequest, notFound } from '../errors.ts'

/**
 * Chatting with Chopper from the RMS. The owner's message waits here; Chopper's
 * relay on the VPS claims it, asks Hermes in one ongoing conversation, and posts
 * the answer back, with any file Chopper made. Vista never calls the VPS: the
 * relay polls, as Chopper already does for the stash.
 */

const STALE_MS = 10 * 60_000
// Vercel takes request bodies up to 4.5 MB; a file travels as base64 (a third larger).
const MAX_FILE = 3 * 1024 * 1024

type Row = { id: bigint; role: string; text: string; status: string; fileName: string | null; fileMime: string | null; replyTo: bigint | null; createdAt: Date }
const view = (m: Row) => ({
  id: m.id.toString(),
  role: m.role,
  text: m.text,
  status: m.status,
  file: m.fileName ? { name: m.fileName, mime: m.fileMime ?? 'application/octet-stream' } : null,
  replyTo: m.replyTo?.toString() ?? null,
  createdAt: m.createdAt.toISOString(),
})
const select = { id: true, role: true, text: true, status: true, fileName: true, fileMime: true, replyTo: true, createdAt: true } as const

export async function chopperChatRoutes(app: FastifyInstance) {
  const owner = { preHandler: requireOwner }
  const relay = { preHandler: requireAgent('BOOKKEEPER') }

  /** The conversation: the latest 60 on first load, then only what is new. */
  app.get('/rms/chopper/chat', owner, async (request) => {
    const { after } = z.object({ after: z.string().regex(/^\d{1,18}$/).optional() }).parse(request.query)
    const rows = after
      ? await request.db.chopperChatMessage.findMany({ where: { id: { gt: BigInt(after) } }, orderBy: { id: 'asc' }, take: 100, select })
      : (await request.db.chopperChatMessage.findMany({ orderBy: { id: 'desc' }, take: 60, select })).reverse()
    // Statuses of messages already on screen change too (working → answered).
    const open = await request.db.chopperChatMessage.findMany({ where: { role: 'owner', status: { in: ['PENDING', 'WORKING'] } }, select })
    return { messages: rows.map(view), open: open.map(view) }
  })

  app.post('/rms/chopper/chat', owner, async (request) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(request.body)
    const row = await request.db.chopperChatMessage.create({ data: { businessId: request.businessId, role: 'owner', text }, select })
    return view(row)
  })

  app.get<{ Params: { id: string } }>('/rms/chopper/chat/:id/file', owner, async (request, reply) => {
    const id = BigInt(z.string().regex(/^\d{1,18}$/).parse(request.params.id))
    const row = await request.db.chopperChatMessage.findFirst({ where: { id }, select: { fileName: true, fileMime: true, fileBytes: true } })
    if (!row?.fileBytes || !row.fileName) throw notFound('agent:CHAT_FILE_NOT_FOUND')
    return reply
      .header('content-type', row.fileMime ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${row.fileName.replace(/"/g, '')}"`)
      .header('access-control-expose-headers', 'content-disposition')
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(row.fileBytes))
  })

  /** The relay takes the oldest waiting message (or one a crashed relay left behind). */
  app.post('/agent/chopper/chat/claim', relay, async (request) => {
    const stale = new Date(Date.now() - STALE_MS)
    const taken = await request.db.$transaction(async (tx) => {
      const next = await tx.chopperChatMessage.findFirst({
        where: { role: 'owner', OR: [{ status: 'PENDING' }, { status: 'WORKING', claimedAt: { lt: stale } }] },
        orderBy: { id: 'asc' },
        select,
      })
      if (!next) return null
      const claimed = await tx.chopperChatMessage.updateMany({ where: { id: next.id, status: next.status }, data: { status: 'WORKING', claimedAt: new Date() } })
      return claimed.count === 1 ? next : null
    })
    return { message: taken ? view(taken) : null }
  })

  app.post<{ Params: { id: string } }>('/agent/chopper/chat/:id/reply', { ...relay, bodyLimit: 4_400_000 }, async (request) => {
    const id = BigInt(z.string().regex(/^\d{1,18}$/).parse(request.params.id))
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
