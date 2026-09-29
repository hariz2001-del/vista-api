import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { attemptLimitConfig, type AttemptOptions } from '../attempts.ts'
import { requireUser, verifySecret } from '../auth.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc, businessToday } from '../domain/business-date.ts'
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

/**
 * A shift's takings: revenue less refunds on its ledger rows, net of discounts.
 * Computed from the ledger rather than taken from anyone, and shared by the
 * cashier's close and the owner's force-close so the two can never disagree.
 */
export async function shiftTakings(
  tx: Tx,
  shiftId: string,
): Promise<{ orderCount: number; systemNetSalesSen: number }> {
  const [orderCount, ledgerTotals] = await Promise.all([
    tx.order.count({ where: { shiftId } }),
    tx.ledgerEntry.groupBy({
      by: ['direction'],
      where: { shiftId, category: { in: ['REVENUE', 'REFUND'] } },
      _sum: { amountSen: true },
    }),
  ])
  const systemNetSalesSen = ledgerTotals.reduce(
    (sum, row) => sum + (row.direction === 'MONEY_IN' ? 1 : -1) * (row._sum.amountSen ?? 0),
    0,
  )
  return { orderCount, systemNetSalesSen }
}

/**
 * Close the open shift if its business day is over.
 *
 * A shift belongs to one business day, and every sale takes that day. Left open
 * past the owner's rollover hour ("trading day ends at"), it would file the next
 * day's sales under the day before — which is what happened to a real stall's
 * Saturday. So it is closed automatically the first time anything looks after
 * the rollover: the tablet starting up, a shift being opened, or the tablet's
 * once-a-minute heartbeat. Takings are computed exactly as at a cashier's close;
 * no cashier is recorded as closing it.
 *
 * Returns the closed shift's id, or null when nothing was stale.
 */
export async function closeStaleShift(db: PrismaClient, businessId: string): Promise<string | null> {
  const today = businessDateToUtc(await businessToday(db, businessId))
  const stale = await db.shift.findFirst({ where: { status: 'OPEN', businessDate: { lt: today } } })
  if (!stale) return null

  return db.$transaction(async (tx) => {
    // The same lock as checkout and the cashier's close, so a sale cannot land
    // between the takings being counted and the shift being marked closed.
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM shifts WHERE id = ${stale.id} AND business_id = ${businessId} FOR UPDATE
    `
    if (locked[0]?.status !== 'OPEN') return null

    const { systemNetSalesSen } = await shiftTakings(tx, stale.id)
    await tx.shift.update({
      where: { id: stale.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedById: null,
        declaredBankTotalSen: null,
        systemNetSalesSen,
        varianceSen: null,
        reconciliationStatus: 'NOT_REQUIRED',
      },
    })
    return stale.id
  })
}

async function assertPin(db: Tx, userId: string, pin: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } })
  if (!user?.pinHash) throw badRequest('auth:NO_PIN_SET')
  if (!(await verifySecret(pin, user.pinHash))) throw unauthorized('auth:INVALID_PIN')
}

export async function shiftRoutes(app: FastifyInstance, options: AttemptOptions): Promise<void> {
  // The PIN guards shift open and close. A 4-digit PIN has 10,000 values, so
  // each route allows at most 10 attempts per 15 minutes per client.
  const pinAttempts = attemptLimitConfig(options)

  app.post('/shifts/open', { preHandler: requireUser, config: pinAttempts }, async (request) => {
    const { pin } = openBody.parse(request.body)
    const db = request.db
    await assertPin(db, request.user.id, pin)

    // Yesterday's shift, never closed: close it now, so today's opens fresh
    // rather than the cashier being quietly put back on yesterday's.
    await closeStaleShift(db, request.businessId)
    const existing = await db.shift.findFirst({ where: { status: 'OPEN' } })
    if (existing) throw conflict('shift:ALREADY_OPEN')

    const businessDate = await businessToday(db, request.businessId)
    const shift = await db.shift.create({
      data: {
        businessId: request.businessId,
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
    { preHandler: requireUser, config: pinAttempts },
    async (request) => {
      const body = closeBody.parse(request.body)
      const db = request.db
      await assertPin(db, request.user.id, body.pin)

      if (body.device_pending_count > 0) throw conflict('shift:UNSYNCED_ORDERS')

      return db.$transaction(async (tx) => {
        // Lock the shift for the duration. Checkout takes the same lock, so the
        // two serialise: a sale cannot land in this shift after its totals have
        // been counted but before it is marked closed. Raw SQL is not scoped by
        // the client, so it filters on the business itself.
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM shifts
           WHERE id = ${request.params.id} AND business_id = ${request.businessId}
             FOR UPDATE
        `
        const shift = locked[0]
        if (!shift) throw notFound('shift:NOT_FOUND')
        if (shift.status !== 'OPEN') throw conflict('shift:ALREADY_CLOSED')

        // Computed here, never taken from the client. This is the figure the
        // owner later checks against the bank statement.
        const { orderCount, systemNetSalesSen } = await shiftTakings(tx, shift.id)
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
          order_count: orderCount,
          system_net_sales_sen: systemNetSalesSen,
          reconciliation_status: updated.reconciliationStatus,
        }
      })
    },
  )
}
