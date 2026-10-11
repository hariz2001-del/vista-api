import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { DomainError } from '../errors.ts'
import { env } from '../env.ts'
import { createDriveFolder, driveConfigured, driveFile, editDriveFile, fileByDate, listDrive, readFromDrive, storeReceiptImage, withinFinances, writeDriveFile } from '../integrations/drive.ts'

const FILE_ID = z.string().regex(/^[a-zA-Z0-9_-]{5,200}$/)
const NAME = z.string().trim().min(1).max(200)
const fail = (error: unknown) => new DomainError('agent:DRIVE_FAILED', 502, error instanceof Error ? error.message : 'Drive request failed.')

export async function agentDriveRoutes(app: FastifyInstance) {
  const guard = (write: boolean) => async (request: Parameters<ReturnType<typeof requireAgent>>[0], reply: Parameters<ReturnType<typeof requireAgent>>[1]) => {
    await requireAgent(write ? 'OWNER' : 'VIEWER')(request, reply)
    // A deployment's Google connection belongs to one business, not all tenants.
    if (!env.DRIVE_BUSINESS_ID || request.businessId !== env.DRIVE_BUSINESS_ID) {
      throw new DomainError('agent:DRIVE_NOT_BOUND', 403, 'This business has no Google Drive connection assigned.')
    }
  }
  const read = { preHandler: guard(false) }
  const write = { preHandler: guard(true) }

  app.get('/agent/drive/status', read, async (request) => {
    if (!driveConfigured()) return { configured: false }
    try {
      const root = await driveFile(env.DRIVE_FINANCES_FOLDER_ID!)
      if (root.mimeType !== 'application/vnd.google-apps.folder' || root.trashed) throw new Error('The configured Finances ID must be an active Google Drive folder.')
      const pending = await request.db.receiptDocument.count({ where: { OR: [{ driveFileId: null }, { image: { scanBytes: { not: null } } }] } })
      return { configured: true, root, pendingReceipts: pending }
    } catch (error) { throw fail(error) }
  })
  app.get('/agent/drive/files', read, async (request) => {
    const query = z.object({ parentId: FILE_ID.optional(), pageToken: z.string().max(2000).optional() }).parse(request.query)
    try { return await listDrive(query.parentId, query.pageToken) } catch (error) { throw fail(error) }
  })
  app.post('/agent/drive/folders', write, async (request) => {
    const body = z.object({ parentId: FILE_ID.optional(), name: NAME }).parse(request.body)
    try { return { file: await createDriveFolder(body.parentId ?? env.DRIVE_FINANCES_FOLDER_ID!, body.name) } } catch (error) { throw fail(error) }
  })
  app.patch<{ Params: { id: string } }>('/agent/drive/files/:id', write, async (request) => {
    const id = FILE_ID.parse(request.params.id)
    const body = z.object({ name: NAME.optional(), parentId: FILE_ID.optional(), description: z.string().max(4000).optional() }).parse(request.body)
    try { return { file: await editDriveFile(id, body) } } catch (error) { throw fail(error) }
  })
  app.get<{ Params: { id: string } }>('/agent/drive/files/:id/content', read, async (request) => {
    const id = FILE_ID.parse(request.params.id)
    try {
      const file = await withinFinances(id)
      if (Number(file.size ?? 0) > 3 * 1024 * 1024 || file.mimeType.startsWith('application/vnd.google-apps.')) throw new Error('Download supports regular files up to 3 MB.')
      const bytes = await readFromDrive(id)
      if (bytes.length > 3 * 1024 * 1024) throw new Error('File exceeds the 3 MB download limit.')
      return { file, contentBase64: bytes.toString('base64') }
    } catch (error) { throw fail(error) }
  })
  app.post('/agent/drive/files', write, async (request) => {
    const body = z.object({ parentId: FILE_ID.optional(), fileId: FILE_ID.optional(), name: NAME, mimeType: z.string().regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/).default('text/plain'), contentBase64: z.string().max(4 * 1024 * 1024) }).parse(request.body)
    try { return { file: await writeDriveFile({ ...body, bytes: Buffer.from(body.contentBase64, 'base64') }) } } catch (error) { throw fail(error) }
  })
  app.post('/agent/drive/sync', write, async (request) => {
    const body = z.object({ receiptId: z.string().uuid().optional(), limit: z.number().int().min(1).max(20).default(10) }).parse(request.body ?? {})
    // Test credentials/root before touching records, so the actual failure reaches Hermes.
    try { await withinFinances(env.DRIVE_FINANCES_FOLDER_ID!) } catch (error) { throw fail(error) }
    const receipts = await request.db.receiptDocument.findMany({
      where: body.receiptId ? { id: body.receiptId } : { OR: [{ driveFileId: null }, { image: { scanBytes: { not: null } } }] },
      orderBy: { createdAt: 'asc' }, take: body.limit,
    })
    const results = []
    for (const receipt of receipts) {
      try {
        const stored = await storeReceiptImage(request.db, receipt.id)
        await fileByDate(request.db, receipt.id)
        const updated = await request.db.receiptDocument.findUniqueOrThrow({ where: { id: receipt.id } })
        results.push({ id: receipt.id, stored, driveUrl: updated.driveUrl })
      } catch (error) { results.push({ id: receipt.id, stored: false, error: error instanceof Error ? error.message : 'Drive request failed' }) }
    }
    return { results }
  })
  app.addHook('onResponse', async (request, reply) => {
    if (!request.agentUser || !request.url.startsWith('/agent/drive/') || request.method === 'GET' || reply.statusCode >= 400) return
    await request.db.agentAction.create({ data: {
      businessId: request.businessId, agentUserId: request.agentUser.id,
      action: `drive.${request.method.toLowerCase()}`, entityType: 'drive', entityId: (request.params as { id?: string }).id ?? 'finances',
      detail: JSON.parse(JSON.stringify({ path: request.routeOptions.url, params: request.params, body: { ...(request.body as object), contentBase64: undefined } })),
    } })
  })
}
