import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import { notFound } from '../errors.ts'
import { readFromDrive } from '../integrations/drive.ts'

/** Drive says the file is gone, trashed or moved out of Finances: the expense stays, the image is reported missing. */
async function driveBytes(fileId: string): Promise<Buffer> {
  try { return await readFromDrive(fileId) } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/\(404\)|drive read 404|outside the configured Finances/.test(message)) throw notFound('agent:RECEIPT_IMAGE_MISSING')
    throw error
  }
}

/** Images remain private in Drive; the signed-in RMS fetches them via Vista. */
export async function expenseReceiptRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/rms/expenses/:id/receipt', { preHandler: requireOwner }, async (request, reply) => {
    const expense = await request.db.expense.findUnique({ where: { id: z.string().uuid().parse(request.params.id) }, include: { receiptDocument: { include: { image: true } } } })
    const receipt = expense?.receiptDocument
    if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
    const original = z.object({ original: z.enum(['true', 'false']).optional() }).parse(request.query).original === 'true'
    const scanned = (!original || Boolean((receipt.extracted as any)?._inbox?.originalRetired)) && (receipt.image?.scanBytes || receipt.scanDriveFileId && !(receipt.extracted as any)?._driveFiles?.[receipt.scanDriveFileId]?.trashed)
    const activeFile = scanned ? receipt.scanDriveFileId : receipt.driveFileId
    if (activeFile && (receipt.extracted as any)?._driveFiles?.[activeFile]?.trashed) throw notFound('agent:RECEIPT_IMAGE_MISSING', 'in recoverable Drive Trash')
    const bytes = scanned ? receipt.image?.scanBytes ? Buffer.from(receipt.image.scanBytes) : await driveBytes(receipt.scanDriveFileId!) : receipt.image ? Buffer.from(receipt.image.bytes) : receipt.driveFileId ? await driveBytes(receipt.driveFileId) : null
    if (!bytes) throw notFound('agent:RECEIPT_NOT_FOUND')
    reply.header('Cache-Control', 'private, no-store')
    return { receiptId: receipt.id, mimeType: scanned ? 'image/jpeg' : receipt.mimeType, imageBase64: bytes.toString('base64'), driveUrl: scanned ? receipt.scanDriveUrl : receipt.driveUrl, hasScan: Boolean(receipt.image?.scanBytes || receipt.scanDriveFileId) }
  })
}
