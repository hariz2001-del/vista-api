import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import type { Tx } from '../db.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { loadExisting, recordCorrection, serialise, type LockedShift } from './corrections.ts'

/**
 * Owner fixes from the RMS: refund items or cancel a sale after the fact, e.g.
 * a refund the counter gave but never keyed in. Same correction rows, cash-book
 * lines and closed-shift adjustment as a correction made at the till.
 */

type TicketLine = {
  product_id: string
  product_name: string
  brand_id: string
  category_id: string
  quantity: number
  unit_price_sen: number
  modifier_total_sen: number
  discount_sen: number
  allocated_cart_discount_sen: number
  modifiers: Array<{ modifier_id: string | null; name: string; price_sen: number; type: string }>
}

const lineNet = (line: TicketLine) =>
  (line.unit_price_sen + line.modifier_total_sen) * line.quantity - line.discount_sen - line.allocated_cart_discount_sen

const withTicket = {
  items: { include: { modifiers: true } },
  corrections: { include: { brandDeltas: true } },
} satisfies Prisma.OrderInclude
type OrderWithTicket = Prisma.OrderGetPayload<{ include: typeof withTicket }>

/** The ticket as it stands now: the latest exchange's replacement, else the sale as rung up; empty once cancelled. */
function currentTicket(order: OrderWithTicket): TicketLine[] {
  const history = order.corrections.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  if (history.some((correction) => correction.kind === 'CANCEL')) return []
  const exchange = history.filter((correction) => correction.kind === 'EXCHANGE').at(-1)
  if (exchange?.replacementItems) return exchange.replacementItems as unknown as TicketLine[]
  return order.items.map((item) => ({
    product_id: item.productId,
    product_name: item.productName,
    brand_id: item.brandId,
    category_id: item.categoryId,
    quantity: item.quantity,
    unit_price_sen: item.unitPriceSen,
    modifier_total_sen: item.modifierTotalSen,
    discount_sen: item.lineDiscountSen,
    allocated_cart_discount_sen: item.allocatedOrderDiscountSen,
    modifiers: item.modifiers.map((modifier) => ({
      modifier_id: modifier.modifierItemId,
      name: modifier.name,
      price_sen: modifier.priceSen,
      type: modifier.type,
    })),
  }))
}

/** Refund `count` of a line's units at what was actually charged for them, discounts included. */
function refundLine(line: TicketLine, count: number): { refundSen: number; remaining: TicketLine | null } {
  const net = lineNet(line)
  const keep = line.quantity - count
  if (keep === 0) return { refundSen: net, remaining: null }
  const keptNet = Math.round((net * keep) / line.quantity)
  const discount = Math.round((line.discount_sen * keep) / line.quantity)
  return {
    refundSen: net - keptNet,
    remaining: {
      ...line,
      quantity: keep,
      discount_sen: discount,
      allocated_cart_discount_sen: (line.unit_price_sen + line.modifier_total_sen) * keep - discount - keptNet,
    },
  }
}

const body = z
  .object({
    client_txn_id: z.string().uuid(),
    reason: z.string().trim().min(1).max(240),
    /** What the owner was shown: refused if the sale changed before they confirmed. */
    expected_refund_sen: z.number().int().positive(),
    cancel: z.boolean().default(false),
    refunds: z.array(z.object({ line: z.number().int().min(0), quantity: z.number().int().positive() })).max(100).default([]),
  })
  .refine((value) => value.cancel || value.refunds.length > 0, { message: 'Choose items to refund, or cancel the sale.' })

const loadOrder = (tx: Tx, id: string) => tx.order.findUnique({ where: { id }, include: withTicket })

export async function rmsCorrectionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orderId: string } }>('/rms/orders/:orderId/ticket', { preHandler: requireOwner }, async (request) => {
    const order = await loadOrder(request.db, z.string().uuid().parse(request.params.orderId))
    if (!order) throw notFound('correction:ORDER_NOT_FOUND')
    return {
      order_id: order.id,
      queue_number: order.queueNumber,
      locked: order.isLocked,
      lines: currentTicket(order).map((line, index) => ({
        line: index,
        product_name: line.product_name,
        brand_id: line.brand_id,
        quantity: line.quantity,
        modifiers: line.modifiers.map((modifier) => modifier.name),
        net_sen: lineNet(line),
      })),
    }
  })

  app.post<{ Params: { orderId: string } }>('/rms/orders/:orderId/corrections', { preHandler: requireOwner }, async (request) => {
    const input = body.parse(request.body)
    const orderId = z.string().uuid().parse(request.params.orderId)
    const { db, businessId } = request
    const existing = await loadExisting(db, input.client_txn_id)
    if (existing) return serialise(existing, true)
    try {
      return await db.$transaction(
        async (tx) => {
          const ref = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, shiftId: true } })
          if (!ref) throw notFound('correction:ORDER_NOT_FOUND')
          // Same lock order as the till and shift close. The shift may be closed:
          // the owner fixes yesterday's sales here, and the closed total follows.
          const shifts = await tx.$queryRaw<LockedShift[]>`
            SELECT id, status, system_net_sales_sen FROM shifts WHERE id = ${ref.shiftId} AND business_id = ${businessId} FOR UPDATE`
          const shift = shifts[0]
          if (!shift) throw notFound('shift:NOT_FOUND')
          await tx.$queryRaw`SELECT id FROM orders WHERE id = ${ref.id} AND business_id = ${businessId} FOR UPDATE`
          const replay = await loadExisting(tx, input.client_txn_id)
          if (replay) return serialise(replay, true)
          const order = await loadOrder(tx, ref.id)
          if (!order) throw notFound('correction:ORDER_NOT_FOUND')
          if (order.isLocked) throw conflict('correction:PERIOD_LOCKED')

          const ticket = currentTicket(order)
          if (!ticket.length || ticket.reduce((sum, line) => sum + lineNet(line), 0) <= 0) {
            throw conflict('correction:ALREADY_CANCELLED')
          }
          const refundByLine = new Map<number, number>()
          if (input.cancel) ticket.forEach((line, index) => refundByLine.set(index, line.quantity))
          else for (const { line, quantity } of input.refunds) refundByLine.set(line, (refundByLine.get(line) ?? 0) + quantity)
          if ([...refundByLine.keys()].some((index) => !ticket[index])) throw badRequest('correction:UNKNOWN_LINE')

          const byBrand = new Map<string, number>()
          const remaining: TicketLine[] = []
          ticket.forEach((line, index) => {
            const count = refundByLine.get(index) ?? 0
            if (count > line.quantity) throw badRequest('correction:REFUND_TOO_MANY', `line ${index + 1} has ${line.quantity}`)
            if (count === 0) {
              remaining.push(line)
              return
            }
            const { refundSen, remaining: rest } = refundLine(line, count)
            byBrand.set(line.brand_id, (byBrand.get(line.brand_id) ?? 0) - refundSen)
            if (rest) remaining.push(rest)
          })
          const brandDeltas = [...byBrand]
            .map(([brandId, deltaSen]) => ({ brandId, deltaSen }))
            .filter((delta) => delta.deltaSen !== 0)
          const deltaSen = brandDeltas.reduce((sum, delta) => sum + delta.deltaSen, 0)
          if (-deltaSen !== input.expected_refund_sen) {
            throw conflict('correction:DELTA_MISMATCH', `refund is ${-deltaSen} sen, the screen showed ${input.expected_refund_sen} sen`)
          }
          const cancelled = remaining.length === 0
          const correction = await recordCorrection(tx, {
            businessId,
            order,
            shift,
            userId: request.user.id,
            clientTxnId: input.client_txn_id,
            kind: cancelled ? 'CANCEL' : 'EXCHANGE',
            reason: input.reason,
            label: cancelled ? 'Cancel (RMS)' : 'Refund (RMS)',
            deltaSen,
            brandDeltas,
            replacementItems: cancelled ? Prisma.DbNull : (remaining as unknown as Prisma.InputJsonValue),
            replacementCartDiscountSen: cancelled ? null : remaining.reduce((sum, line) => sum + line.allocated_cart_discount_sen, 0),
            replacementTotalSen: cancelled ? null : remaining.reduce((sum, line) => sum + lineNet(line), 0),
            replacementMenuPriceSen: cancelled
              ? null
              : remaining.reduce((sum, line) => sum + (line.unit_price_sen + line.modifier_total_sen) * line.quantity, 0),
          })
          return serialise(correction, false)
        },
        { timeout: 15_000 },
      )
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await loadExisting(db, input.client_txn_id)
        if (winner) return serialise(winner, true)
        throw conflict('correction:DUPLICATE_TRANSACTION')
      }
      throw error
    }
  })
}
