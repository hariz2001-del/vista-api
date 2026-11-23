import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth.ts'
import { readDriveFile } from '../campaigns/google.ts'
import { activeCampaigns, couponDesignFile, findCampaignCoupons, lookupCoupon } from '../campaigns/redeem.ts'
import { sourceCredentials } from '../campaigns/sync.ts'
import { businessToday } from '../domain/business-date.ts'
import { badRequest, notFound } from '../errors.ts'

/**
 * The till finds a campaign coupon before adding it to an order — by its code
 * (scanned or keyed in) or, for a customer who did not keep it, by phone
 * number. Read-only: a coupon is only used up by the checkout that sells it.
 */
const dateQuery = z.object({ business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
const findQuery = dateQuery.extend({
  phone: z.string().trim().min(1).max(40).optional(),
  code: z.string().trim().min(1).max(40).optional(),
})
const codeParam = z.string().trim().min(3).max(40)

export async function campaignPosRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pos/campaigns', { preHandler: requireUser }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { campaigns: await activeCampaigns(request.db, request.businessId) }
  })

  app.get<{ Params: { id: string } }>('/pos/campaigns/:id/coupons', { preHandler: requireUser }, async (request, reply) => {
    const campaignId = z.string().uuid().parse(request.params.id)
    const { business_date, phone, code } = findQuery.parse(request.query)
    if ((phone === undefined) === (code === undefined)) throw badRequest('coupon:SEARCH_ONE')
    reply.header('Cache-Control', 'no-store')
    const businessDate = business_date ?? (await businessToday(request.db, request.businessId))
    return { coupons: await findCampaignCoupons(request.db, { businessId: request.businessId, campaignId, businessDate, phone, code }) }
  })

  app.get<{ Params: { code: string } }>('/pos/coupons/:code', { preHandler: requireUser }, async (request, reply) => {
    const code = codeParam.parse(request.params.code)
    const { business_date } = dateQuery.parse(request.query)
    reply.header('Cache-Control', 'no-store')
    return lookupCoupon(request.db, code, business_date ?? (await businessToday(request.db, request.businessId)))
  })

  /** The set's design preview, so staff can match the coupon to the right bouquet. */
  app.get<{ Params: { code: string } }>('/pos/coupons/:code/design', { preHandler: requireUser }, async (request, reply) => {
    const design = await couponDesignFile(request.db, codeParam.parse(request.params.code))
    if (!design) throw notFound('campaign:DESIGN_NOT_FOUND')
    let file: { bytes: Buffer; mimeType: string }
    try {
      file = await readDriveFile(sourceCredentials(design.campaign), design.fileId)
    } catch {
      throw badRequest('campaign:DESIGN_UNAVAILABLE')
    }
    // Only ever hand back a picture: the link came from a sheet anyone with edit access can change.
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.mimeType)) throw badRequest('campaign:DESIGN_UNAVAILABLE')
    reply.header('Content-Type', file.mimeType).header('Cache-Control', 'private, no-store')
    return reply.send(file.bytes)
  })
}
