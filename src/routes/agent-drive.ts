import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
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

  // Chopper already changed Drive directly. This is a separate idempotent
  // record notification, not a file-operation proxy or an accounting mutation.
  app.post('/agent/drive/changes', write, async request => {
    const event = z.object({ operationId: z.string().regex(/^[a-f0-9]{32}$/), fileId: FILE_ID,
      operation: z.enum(['replace', 'trash', 'restore']), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), backupFileId: FILE_ID.optional() }).strict().parse(request.body)
    const file = await withinFinances(event.fileId, true)
    if (file.id === env.DRIVE_FINANCES_FOLDER_ID) throw new DomainError('agent:ROOT_PROTECTED', 403, 'Finances root is protected.')
    if (Boolean(file.trashed) !== (event.operation === 'trash')) throw new DomainError('agent:DRIVE_STATE_CHANGED', 409, 'Drive state does not match the notification.')
    if (event.operation === 'replace') {
      if (!event.sha256 || !event.backupFileId || Number(file.size ?? 0) > 3 * 1024 * 1024) throw new DomainError('agent:REPLACEMENT_UNVERIFIED', 409, 'Replacement requires a bounded verified backup and digest.')
      const backup = await withinFinances(event.backupFileId)
      if (backup.appProperties?.chopperBackupFor !== file.id || backup.appProperties?.chopperOperationId !== event.operationId) throw new DomainError('agent:BACKUP_UNVERIFIED', 409, 'Backup association does not match this operation.')
      const bytes = await readFromDrive(file.id)
      if (createHash('sha256').update(bytes).digest('hex') !== event.sha256) throw new DomainError('agent:DRIVE_STATE_CHANGED', 409, 'Replacement bytes do not match the notification.')
    }
    return request.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${request.businessId + ':' + event.operationId}))::text`
      const prior = await tx.agentAction.findFirst({ where: { action: 'chopper.drive.synced', entityId: event.operationId } })
      if (prior) {
        const saved = prior.detail as any
        if (prior.agentUserId !== request.agentUser!.id || saved.fileId !== event.fileId || saved.operation !== event.operation || saved.sha256 !== event.sha256 || saved.backupFileId !== event.backupFileId) throw new DomainError('agent:OPERATION_MISMATCH', 409, 'Operation ID belongs to a different confirmed change.')
        return { synced: true, alreadySynced: true, receiptIds: saved.receiptIds }
      }
      const receipts = await tx.receiptDocument.findMany({ where: { OR: [{ driveFileId: file.id }, { scanDriveFileId: file.id }, { extracted: { path: ['_lineWorkflow', 'annotation', 'id'], equals: file.id } }] }, orderBy: { id: 'asc' } })
      for (const snapshot of receipts) {
        await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id=${snapshot.id} AND business_id=${request.businessId} FOR UPDATE`
        const receipt = await tx.receiptDocument.findUniqueOrThrow({ where: { id: snapshot.id }, include: { job: true } })
        // A worker may hold old bytes. Its finish cannot be accepted after a change.
        if (receipt.job) await tx.receiptJob.update({ where: { id: receipt.job.id }, data: { status: 'DONE', leaseUntil: null, error: 'Owner changed Drive evidence; review before reprocessing.' } })
        const x = JSON.parse(JSON.stringify(receipt.extracted ?? {})) as any
        x._driveFiles ??= {}
        x._driveFiles[file.id] = { operation: event.operation, operationId: event.operationId, trashed: Boolean(file.trashed), sha256: event.sha256, backupFileId: event.backupFileId, at: new Date().toISOString() }
        delete x._entryForms
        const data: any = { extracted: JSON.parse(JSON.stringify(x)) }
        if (event.operation === 'replace') {
          x._imageReplacement = { fileId: file.id, sha256: event.sha256, backupFileId: event.backupFileId, readingPreserved: true, needsVisualReview: true }
          // Preserve receipt UUID, intake dedup hash, reading, allocations, and expenses.
          // A replacement original invalidates derived scans, not ledger records.
          if (receipt.driveFileId === file.id && receipt.scanDriveFileId !== file.id) {
            data.mimeType = file.mimeType
            data.scanDriveFileId = null; data.scanDriveUrl = null
            delete x.scan
            if (x._lineWorkflow) delete x._lineWorkflow.annotation
          } else if (receipt.scanDriveFileId === file.id) {
            delete x.scan // Old corners/hash must never be applied to new pixels.
            if (x._lineWorkflow) delete x._lineWorkflow.annotation
          }
          data.reviewFlags = [...new Set([...receipt.reviewFlags, 'replacement image: review reading and scan'])]
          data.extracted = JSON.parse(JSON.stringify(x))
        }
        await tx.receiptImage.deleteMany({ where: { receiptId: receipt.id } })
        await tx.receiptDocument.update({ where: { id: receipt.id }, data })
      }
      const receiptIds = receipts.map(r => r.id)
      await tx.agentAction.create({ data: { businessId: request.businessId, agentUserId: request.agentUser!.id, action: 'chopper.drive.synced', entityType: 'drive', entityId: event.operationId, detail: JSON.parse(JSON.stringify({ ...event, receiptIds, accounting: 'unchanged' })) } })
      return { synced: true, receiptIds, accounting: 'unchanged' }
    })
  })

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
