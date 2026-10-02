import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth.ts'
import { businessDateToUtc } from '../domain/business-date.ts'

const receiptsQuery = z.object({
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

/**
 * Every receipt for one business day, for the counter's Receipts screen.
 *
 * A tablet only holds the sales it rang up itself, so without this a second
 * tablet — or the same one after a reinstall — shows an empty list. Answered in
 * the shape the tablet keeps its own sales in, so both can sit in one list.
 *
 * Corrections are fetched by the order they amend rather than by their own
 * date: a sale cancelled the morning after still reads as cancelled.
 */
export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.get('/receipts', { preHandler: requireUser }, async (request) => {
    const query = receiptsQuery.parse(request.query)
    const { db } = request

    const orders = await db.order.findMany({
      where: { businessDate: businessDateToUtc(query.business_date) },
      orderBy: { completedAt: 'desc' },
      include: { items: { include: { modifiers: true } } },
    })

    const corrections = orders.length
      ? await db.saleCorrection.findMany({
          where: { originalOrderId: { in: orders.map((order) => order.id) } },
          orderBy: { createdAt: 'asc' },
          include: {
            brandDeltas: { include: { brand: { select: { name: true } } } },
            originalOrder: { select: { clientTxnId: true, queueNumber: true } },
          },
        })
      : []

    return {
      orders: orders.map((order) => ({
        order_id: order.id,
        client_txn_id: order.clientTxnId,
        shift_id: order.shiftId,
        business_date: order.businessDate.toISOString().slice(0, 10),
        queue_number: order.queueNumber,
        offline_label: order.offlineLabel,
        total_amount_sen: order.totalAmountSen,
        menu_price_sen: order.menuPriceSen,
        item_count: order.items.reduce((sum, item) => sum + item.quantity, 0),
        completed_at: order.completedAt.toISOString(),
        cart_discount_sen: order.orderDiscountSen,
        cart_items: order.items.map((item) => ({
          product_id: item.productId,
          product_name: item.productName,
          brand_id: item.brandId,
          category_id: item.categoryId,
          quantity: item.quantity,
          unit_price_sen: item.unitPriceSen,
          modifier_total_sen: item.modifierTotalSen,
          discount_sen: item.lineDiscountSen,
          modifiers: item.modifiers.map((modifier) => ({
            modifier_id: modifier.modifierItemId,
            name: modifier.name,
            price_sen: modifier.priceSen,
            type: modifier.type,
          })),
        })),
      })),
      corrections: corrections.map((correction) => ({
        correction_id: correction.id,
        client_txn_id: correction.clientTxnId,
        original_client_txn_id: correction.originalOrder.clientTxnId,
        original_queue_number: correction.originalOrder.queueNumber,
        shift_id: correction.shiftId,
        business_date: correction.businessDate.toISOString().slice(0, 10),
        kind: correction.kind,
        reason: correction.reason,
        delta_sen: correction.deltaSen,
        brand_deltas: correction.brandDeltas.map((delta) => ({
          brand_id: delta.brandId,
          brand_name: delta.brand.name,
          delta_sen: delta.deltaSen,
        })),
        replacement_items: correction.replacementItems,
        replacement_cart_discount_sen: correction.replacementCartDiscountSen,
        created_at: correction.createdAt.toISOString(),
      })),
    }
  })
}
