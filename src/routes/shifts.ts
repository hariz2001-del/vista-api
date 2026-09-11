import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser, verifySecret } from '../auth.ts'
import { prisma } from '../db.ts'
import { businessDateToUtc, getBusinessDate } from '../domain/business-date.ts'
import { badRequest, conflict, notFound, unauthorized } from '../errors.ts'

const openBody = z.object({ pin: z.string().min(4).max(8) })

const closeBody = z.object({
  pin: z.string().min(4).max(8),
  declared_bank_total_sen: z.number().int().min(0),
  /**
   * How many sales the device is still holding. The server cannot see a sale
   * that has not reached it, so this is the only signal available — a safety
   * net against closing a shift with money still on the tablet, not a security
   * control.
   */
  device_pending_count: z.number().int().min(0).default(0),
})

async function assertPin(userId: string, pin: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user?.pinHash) throw badRequest('auth:NO_PIN_SET')
  if (!(await verifySecret(pin, user.pinHash))) throw unauthorized('auth:INVALID_PIN')
}

export async function shiftRoutes(app: FastifyInstance): Promise<void> {
  app.post('/shifts/open', { preHandler: requireUser }, async (request) => {
    const { pin } = openBody.parse(request.body)
    await assertPin(request.user.id, pin)

    const existing = await prisma.shift.findFirst({ where: { status: 'OPEN' } })
    if (existing) throw conflict('shift:ALREADY_OPEN')

    const businessDate = getBusinessDate(new Date())
    const shift = await prisma.shift.create({
      data: {
        businessDate: businessDateToUtc(businessDate),
        status: 'OPEN',
        openedById: request.user.id,
      },
    })

    return {
      id: shift.id,
      business_date: businessDate,
      opened_at: shift.openedAt.toISOString(),
    }
  })

  app.post<{ Params: { id: string } }>(
    '/shifts/:id/close',
    { preHandler: requireUser },
    async (request) => {
      const body = closeBody.parse(request.body)
      await assertPin(request.user.id, body.pin)

      if (body.device_pending_count > 0) throw conflict('shift:UNSYNCED_ORDERS')

      return prisma.$transaction(async (tx) => {
        // Lock the shift for the duration. Checkout takes the same lock, so the
        // two serialise: a sale cannot land in this shift after its totals have
        // been counted but before it is marked closed.
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM shifts WHERE id = ${request.params.id} FOR UPDATE
        `
        const shift = locked[0]
        if (!shift) throw notFound('shift:NOT_FOUND')
        if (shift.status !== 'OPEN') throw conflict('shift:ALREADY_CLOSED')

        // Computed here, never taken from the client. Net of discounts, so it
        // compares like-for-like against what the bank actually received —
        // comparing a pre-discount figure would show a phantom variance equal
        // to the day's discounts on every single shift.
        const totals = await tx.order.aggregate({
          where: { shiftId: shift.id },
          _sum: { totalAmountSen: true },
          _count: true,
        })
        const systemNetSalesSen = totals._sum.totalAmountSen ?? 0
        const varianceSen = body.declared_bank_total_sen - systemNetSalesSen

        const updated = await tx.shift.update({
          where: { id: shift.id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closedById: request.user.id,
            declaredBankTotalSen: body.declared_bank_total_sen,
            systemNetSalesSen,
            varianceSen,
            // A gap is never silently absorbed. It stays visible until the
            // owner says what it was, and that action writes the ledger entry.
            reconciliationStatus: varianceSen === 0 ? 'NOT_REQUIRED' : 'UNRECONCILED',
          },
        })

        return {
          id: updated.id,
          business_date: updated.businessDate.toISOString().slice(0, 10),
          order_count: totals._count,
          system_net_sales_sen: systemNetSalesSen,
          declared_bank_total_sen: body.declared_bank_total_sen,
          variance_sen: varianceSen,
          reconciliation_status: updated.reconciliationStatus,
        }
      })
    },
  )
}
