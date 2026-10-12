import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import { notFound } from '../errors.ts'
import { readFromDrive } from '../integrations/drive.ts'

/** Images remain private in Drive; the signed-in RMS fetches them via Vista. */
export async function expenseReceiptRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/rms/expenses/:id/receipt', { preHandler: requireOwner }, async (request, reply) => {
    const expense = await request.db.expense.findUnique({ where: { id: z.string().uuid().parse(request.params.id) }, include: { receiptDocument: { include: { image: true } } } })
    const receipt = expense?.receiptDocument
    if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
    const original = z.object({ original: z.enum(['true', 'false']).optional() }).parse(request.query).original === 'true'
    const scanned = (!original || Boolean((receipt.extracted as any)?._inbox?.originalRetired)) && (receipt.image?.scanBytes || receipt.scanDriveFileId)
    const bytes = scanned ? receipt.image?.scanBytes ? Buffer.from(receipt.image.scanBytes) : await readFromDrive(receipt.scanDriveFileId!) : receipt.image ? Buffer.from(receipt.image.bytes) : receipt.driveFileId ? await readFromDrive(receipt.driveFileId) : null
    if (!bytes) throw notFound('agent:RECEIPT_NOT_FOUND')
    reply.header('Cache-Control', 'private, no-store')
    return { receiptId: receipt.id, mimeType: scanned ? 'image/jpeg' : receipt.mimeType, imageBase64: bytes.toString('base64'), driveUrl: scanned ? receipt.scanDriveUrl : receipt.driveUrl, hasScan: Boolean(receipt.image?.scanBytes || receipt.scanDriveFileId) }
  })
}
