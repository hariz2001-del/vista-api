import type { FastifyReply } from 'fastify'

/** A file Vista made: the same bytes for an RMS download and for Sarang AI. */
export type MadeFile = { filename: string; mimeType: 'application/pdf' | 'image/png'; bytes: Buffer }

export function sendFile(reply: FastifyReply, file: MadeFile) {
  return reply
    .header('content-type', file.mimeType)
    .header('content-disposition', `attachment; filename="${file.filename}"`)
    .header('cache-control', 'no-store')
    // The RMS reads the file name from here, across origins.
    .header('access-control-expose-headers', 'content-disposition')
    .send(file.bytes)
}
