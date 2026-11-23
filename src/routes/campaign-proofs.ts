import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { requireAgent, requireOwner } from '../auth.ts'
import { campaignActor, campaignAudit } from '../campaigns/audit.ts'
import { readDriveFile } from '../campaigns/google.ts'
import { reviewProof, type Extraction } from '../campaigns/proof-review.ts'
import { sourceCredentials } from '../campaigns/sync.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

/**
 * Payment-proof reading. Hermes claims one proof at a time, reads it with the
 * same vision model Chopper uses for receipts, and reports what it saw. Vista
 * turns that into flags (src/campaigns/proof-review.ts). Nothing here changes
 * an order's verification: that is always the owner's decision.
 */

const ID = z.string().uuid()
const LEASE_MS = 10 * 60_000
const MAX_ATTEMPTS = 5

const extractionBody = z.object({
  looksLikeReceipt: z.boolean(),
  readable: z.boolean(),
  provider: z.string().trim().max(120).nullable().default(null),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  time: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().default(null),
  amountSen: z.number().int().min(0).max(100_000_000).nullable().default(null),
  reference: z.string().trim().max(120).nullable().default(null),
  recipient: z.string().trim().max(160).nullable().default(null),
  status: z.string().trim().max(80).nullable().default(null),
  concerns: z.array(z.string().trim().max(200)).max(10).default([]),
})

const resultBody = z.object({ leaseToken: z.string().uuid(), extraction: extractionBody })
const failBody = z.object({ leaseToken: z.string().uuid(), error: z.string().max(500) })

type ProofParams = { Params: { id: string } }
type OrderParams = { Params: { id: string; orderId: string } }

/** Screenshots are shrunk before they go to the reader: smaller, and well under the response limit. */
async function forReading(bytes: Buffer, mimeType: string): Promise<{ base64: string; mimeType: string }> {
  if (mimeType === 'application/pdf') return { base64: bytes.toString('base64'), mimeType }
  try {
    const jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
    return { base64: jpeg.toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    return { base64: bytes.toString('base64'), mimeType }
  }
}

export async function campaignProofRoutes(app: FastifyInstance): Promise<void> {
  const reader = { preHandler: requireAgent('BOOKKEEPER') }
  const owner = { preHandler: requireOwner }

  /**
   * The next proof to read, leased for 10 minutes, with the image itself so
   * Hermes never needs the campaign's Google access. Null when there is none.
   */
  app.post('/agent/campaigns/proofs/claim', reader, async (request) => {
    for (let tries = 0; tries < 5; tries++) {
      const leaseToken = randomUUID()
      const [claimed] = await request.db.$queryRaw<{ id: string }[]>`
        UPDATE campaign_payment_proofs p SET read_status = 'READING', lease_token = ${leaseToken},
               lease_until = now() + ${`${LEASE_MS / 1000} seconds`}::interval, attempts = p.attempts + 1, updated_at = now()
        WHERE p.id = (
          SELECT p2.id FROM campaign_payment_proofs p2
          JOIN campaign_orders o ON o.id = p2.order_id AND o.business_id = p2.business_id
          JOIN campaigns c ON c.id = o.campaign_id AND c.business_id = o.business_id
          WHERE p2.business_id = ${request.businessId} AND o.deleted_at IS NULL AND c.status <> 'ARCHIVED'
            AND p2.source_ref IS NOT NULL AND p2.attempts < ${MAX_ATTEMPTS}
            AND (p2.read_status = 'PENDING' OR (p2.read_status = 'READING' AND p2.lease_until < now()))
          ORDER BY o.submitted_at
          LIMIT 1 FOR UPDATE OF p2 SKIP LOCKED)
        RETURNING p.id`
      if (!claimed) return { proof: null }

      const proof = await request.db.campaignPaymentProof.findUniqueOrThrow({
        where: { id: claimed.id },
        include: { order: { include: { campaign: true, lines: { orderBy: { lineNo: 'asc' } } } } },
      })
      const { order } = proof
      try {
        const file = await readDriveFile(sourceCredentials(order.campaign), proof.sourceRef!)
        const sha256 = createHash('sha256').update(file.bytes).digest('hex')
        await request.db.campaignPaymentProof.update({ where: { id: proof.id }, data: { sha256, mimeType: file.mimeType } })
        const image = await forReading(file.bytes, file.mimeType)
        return {
          proof: {
            id: proof.id,
            leaseToken,
            campaign: order.campaign.name,
            orderRef: order.externalRef,
            expectedSen: order.expectedSen,
            submittedAt: order.submittedAt.toISOString(),
            items: order.lines.map((line) => line.label),
            mimeType: image.mimeType,
            imageBase64: image.base64,
          },
        }
      } catch (caught) {
        // The file could not be fetched: count the attempt and try the next proof.
        await request.db.campaignPaymentProof.update({
          where: { id: proof.id },
          data: {
            readStatus: proof.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
            leaseToken: null,
            leaseUntil: null,
            lastError: caught instanceof Error ? caught.message.slice(0, 300) : 'could not fetch the file',
          },
        })
      }
    }
    return { proof: null }
  })

  app.post<ProofParams>('/agent/campaigns/proofs/:id/result', reader, async (request) => {
    const id = ID.parse(request.params.id)
    const body = resultBody.parse(request.body)
    const extraction: Extraction = body.extraction
    return request.db.$transaction(async (tx) => {
      const proof = await tx.campaignPaymentProof.findUnique({ where: { id }, include: { order: true } })
      if (!proof) throw notFound('campaign:PROOF_NOT_FOUND')
      if (proof.leaseToken !== body.leaseToken || proof.readStatus !== 'READING') throw conflict('campaign:PROOF_NOT_FOUND', 'lease lost')
      const review = await reviewProof(tx, {
        orderId: proof.orderId,
        campaignId: proof.order.campaignId,
        expectedSen: proof.order.expectedSen,
        submittedAt: proof.order.submittedAt,
        sha256: proof.sha256,
        extraction,
      })
      await tx.campaignPaymentProof.update({
        where: { id },
        data: {
          readStatus: 'DONE',
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
          extraction: extraction as unknown as Prisma.InputJsonValue,
          flags: review.flags,
          summary: review.summary,
          readAt: new Date(),
          dismissedAt: null,
        },
      })
      await campaignAudit(tx, request.businessId, campaignActor(request), {
        campaignId: proof.order.campaignId,
        orderId: proof.orderId,
        action: 'proof.read',
        after: { flags: review.flags, amountSen: extraction.amountSen, date: extraction.date, reference: extraction.reference },
      })
      return { flags: review.flags, summary: review.summary }
    })
  })

  app.post<ProofParams>('/agent/campaigns/proofs/:id/fail', reader, async (request) => {
    const id = ID.parse(request.params.id)
    const body = failBody.parse(request.body)
    const proof = await request.db.campaignPaymentProof.findUnique({ where: { id } })
    if (!proof) throw notFound('campaign:PROOF_NOT_FOUND')
    if (proof.leaseToken !== body.leaseToken) throw conflict('campaign:PROOF_NOT_FOUND', 'lease lost')
    const gaveUp = proof.attempts >= MAX_ATTEMPTS
    await request.db.campaignPaymentProof.update({
      where: { id },
      data: {
        readStatus: gaveUp ? 'FAILED' : 'PENDING',
        leaseToken: null,
        leaseUntil: null,
        lastError: body.error,
        ...(gaveUp ? { flags: ['UNREADABLE'], summary: 'The reader could not read this proof. Check it by eye.' } : {}),
      },
    })
    return { status: gaveUp ? 'FAILED' : 'PENDING' }
  })

  /** The owner has looked at the flags and is satisfied; they stop showing as needing attention. */
  app.post<OrderParams>('/rms/campaigns/:id/orders/:orderId/proof/dismiss', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    return request.db.$transaction(async (tx) => {
      const proof = await tx.campaignPaymentProof.findFirst({ where: { orderId, order: { campaignId } } })
      if (!proof) throw notFound('campaign:PROOF_NOT_FOUND')
      await tx.campaignPaymentProof.update({ where: { id: proof.id }, data: { dismissedAt: new Date() } })
      await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'proof.dismiss', before: { flags: proof.flags } })
      return { ok: true }
    })
  })

  /** Read it again (e.g. after the reader improved, or a flag looks wrong). */
  app.post<OrderParams>('/rms/campaigns/:id/orders/:orderId/proof/reread', owner, async (request) => {
    const campaignId = ID.parse(request.params.id)
    const orderId = ID.parse(request.params.orderId)
    return request.db.$transaction(async (tx) => {
      const proof = await tx.campaignPaymentProof.findFirst({ where: { orderId, order: { campaignId } } })
      if (!proof?.sourceRef) throw notFound('campaign:PROOF_NOT_FOUND')
      if (proof.readStatus === 'READING') throw badRequest('campaign:SYNC_RUNNING', 'already being read')
      await tx.campaignPaymentProof.update({
        where: { id: proof.id },
        data: { readStatus: 'PENDING', attempts: 0, lastError: null, leaseToken: null, leaseUntil: null },
      })
      await campaignAudit(tx, request.businessId, campaignActor(request), { campaignId, orderId, action: 'proof.reread' })
      return { ok: true }
    })
  })
}
