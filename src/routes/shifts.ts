import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser, verifySecret } from '../auth.ts'
import { prisma } from '../db.ts'
import { businessDateToUtc, getBusinessDate } from '../domain/business-date.ts'
import { badRequest, conflict, notFound, unauthorized } from '../errors.ts'

const openBody = z.object({ pin: z.string().min(4).max(8) })

/**
 * Closing takes the PIN and nothing else. The cashier is not asked what the bank
 * received: they cannot see the account, and a figure typed in at 2am is a guess.
 * The server records its own total; checking it against the bank is the owner's
 * job in the RMS, through Adjust Balance, when they choose to.
 *
 * An older client that still sends `declared_bank_total_sen` is not refused —
 * unknown keys are stripped — but the figure is ignored.
 */
const closeBody = z.object({
  pin: z.string().min(4).max(8),
  /**
   * How many financial records the device is still holding. The server cannot
   * see a sale or correction that has not reached it, so this is the only signal — a safety
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

        // Computed here, never taken from the client: revenue less refunds for
        // this shift, net of discounts. This is the figure the owner later checks
        // against the bank statement.
        const [totals, ledgerTotals] = await Promise.all([
          tx.order.aggregate({
            where: { shiftId: shift.id },
            _count: true,
          }),
          tx.ledgerEntry.groupBy({
            by: ['direction'],
            where: {
              shiftId: shift.id,
              category: { in: ['REVENUE', 'REFUND'] },
            },
            _sum: { amountSen: true },
          }),
        ])
        const systemNetSalesSen = ledgerTotals.reduce(
          (sum, row) =>
            sum + (row.direction === 'MONEY_IN' ? 1 : -1) * (row._sum.amountSen ?? 0),
          0,
        )
        const updated = await tx.shift.update({
          where: { id: shift.id },
          data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closedById: request.user.id,
            // Nothing was declared, so there is nothing to compare and no
            // variance to record. A gap the owner finds later is closed with a
            // RECONCILIATION_ADJUSTMENT entry from the RMS.
            declaredBankTotalSen: null,
            systemNetSalesSen,
            varianceSen: null,
            reconciliationStatus: 'NOT_REQUIRED',
          },
        })

        return {
          id: updated.id,
          business_date: updated.businessDate.toISOString().slice(0, 10),
          order_count: totals._count,
          system_net_sales_sen: systemNetSalesSen,
          reconciliation_status: updated.reconciliationStatus,
        }
      })
    },
  )
}
