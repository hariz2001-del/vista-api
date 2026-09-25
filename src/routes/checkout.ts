import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth.ts'
import type { Tx } from '../db.ts'
import { businessDateToUtc } from '../domain/business-date.ts'
import { priceOrder, type PricedLineInput } from '../domain/cart.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

const modifierSchema = z.object({
  /** Required: without it the server has no key to reprice a modifier against. */
  modifier_id: z.string().uuid(),
})

const itemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  discount_sen: z.number().int().min(0).default(0),
  modifiers: z.array(modifierSchema).default([]),
  /**
   * What the device actually charged for this line. For an `OFFLINE_SYNC` only.
   *
   * An offline tablet priced from a cached menu, so only it knows what the
   * customer handed over. Ignored for an online checkout, where the server's own
   * price is the price.
   */
  charged_unit_price_sen: z.number().int().min(0).optional(),
  charged_modifier_total_sen: z.number().int().min(0).optional(),
})

const checkoutBody = z.object({
  shift_id: z.string().uuid(),
  client_txn_id: z.string().uuid(),
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  origin: z.enum(['ONLINE', 'OFFLINE_SYNC']).default('ONLINE'),
  offline_label: z.string().max(32).nullish(),
  /** What the cashier was shown. Checked against the server's own figure. */
  claimed_total_sen: z.number().int().min(0),
  cart_discount_sen: z.number().int().min(0).default(0),
  cart_items: z.array(itemSchema).min(1),
})

type CheckoutBody = z.infer<typeof checkoutBody>

function formatQueueNumber(value: number): string {
  return `#${value.toString().padStart(3, '0')}`
}

/**
 * Allocate the business's next queue number for the day.
 *
 * The UPDATE takes the row lock itself, so there is no read-then-increment gap
 * for a second terminal to slip into. A rolled-back checkout leaves no hole,
 * because the increment rolls back with it. Raw SQL is not scoped by the
 * client, so both statements name the business themselves.
 */
async function allocateQueueNumber(
  tx: Tx,
  businessId: string,
  businessDate: string,
): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO queue_counters (business_id, business_date, current_val, updated_at)
    VALUES (${businessId}, ${businessDate}::date, 0, now())
    ON CONFLICT (business_id, business_date) DO NOTHING
  `
  const rows = await tx.$queryRaw<Array<{ current_val: number }>>`
    UPDATE queue_counters
       SET current_val = current_val + 1, updated_at = now()
     WHERE business_id = ${businessId} AND business_date = ${businessDate}::date
     RETURNING current_val
  `
  const next = rows[0]?.current_val
  if (next === undefined) throw badRequest('server:UNEXPECTED', 'queue counter not allocated')
  return formatQueueNumber(next)
}

async function loadExisting(client: Tx, clientTxnId: string) {
  return client.order.findUnique({
    where: { clientTxnId },
    include: { items: { include: { modifiers: true } } },
  })
}

function serialise(order: NonNullable<Awaited<ReturnType<typeof loadExisting>>>, replayed: boolean) {
  return {
    order_id: order.id,
    queue_number: order.queueNumber,
    offline_label: order.offlineLabel,
    business_date: order.businessDate.toISOString().slice(0, 10),
    total_amount_sen: order.totalAmountSen,
    menu_price_sen: order.menuPriceSen,
    item_count: order.items.reduce((sum, item) => sum + item.quantity, 0),
    needs_review: order.needsReview,
    review_reason: order.reviewReason,
    replayed,
  }
}

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  app.post('/checkout', { preHandler: requireUser }, async (request) => {
    const body = checkoutBody.parse(request.body)
    const userId = request.user.id
    const { db, businessId } = request

    // Cheap pre-check outside the transaction. The unique index is what actually
    // guarantees correctness; this just avoids doing the work twice.
    const alreadyDone = await loadExisting(db, body.client_txn_id)
    if (alreadyDone) return serialise(alreadyDone, true)

    try {
      return await db.$transaction((tx) => runCheckout(tx, body, userId, businessId), {
        timeout: 15_000,
      })
    } catch (error) {
      // Lost a race to a concurrent identical request. The other one won and
      // wrote the sale; return that rather than failing the cashier.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await loadExisting(db, body.client_txn_id)
        if (winner) return serialise(winner, true)
        // The id is taken, but not by this business. Transaction ids are
        // random, so this is a forged or corrupted request — and it must never
        // be answered with another business's sale.
        throw conflict('checkout:DUPLICATE_TRANSACTION')
      }
      throw error
    }
  })
}

async function runCheckout(tx: Tx, body: CheckoutBody, userId: string, businessId: string) {
  const replay = await loadExisting(tx, body.client_txn_id)
  if (replay) return serialise(replay, true)

  // Lock the shift. Close takes the same lock, so a sale can never land in a
  // shift whose totals have already been counted.
  // Ids are text columns, not Postgres uuid — no cast, or the comparison
  // becomes uuid = text and Postgres refuses it. Raw SQL is not scoped by the
  // client: a shift of another business must read as not found.
  const shifts = await tx.$queryRaw<
    Array<{ id: string; status: string; system_net_sales_sen: number | null }>
  >`
    SELECT id, status, system_net_sales_sen
      FROM shifts WHERE id = ${body.shift_id} AND business_id = ${businessId} FOR UPDATE
  `
  const shift = shifts[0]
  if (!shift) throw notFound('shift:NOT_FOUND')

  // A sale queued at 2:50am that syncs after the cashier closed is the normal
  // case, not an edge case. Money was collected; refusing it would destroy a
  // real sale. Take it, flag it, and reopen the reconciliation on that shift so
  // the owner sees the totals moved.
  const lateSync = shift.status !== 'OPEN'
  if (lateSync && body.origin !== 'OFFLINE_SYNC') throw conflict('checkout:SHIFT_NOT_OPEN')

  // ---- Re-price from the catalogue. Nothing the client sent is trusted. ----

  const productIds = [...new Set(body.cart_items.map((item) => item.product_id))]
  const products = await tx.product.findMany({ where: { id: { in: productIds } } })
  const productById = new Map(products.map((product) => [product.id, product]))

  const modifierIds = [
    ...new Set(body.cart_items.flatMap((item) => item.modifiers.map((m) => m.modifier_id))),
  ]
  const modifierItems = modifierIds.length
    ? await tx.modifierItem.findMany({ where: { id: { in: modifierIds } } })
    : []
  const modifierById = new Map(modifierItems.map((item) => [item.id, item]))

  const priceInputs: PricedLineInput[] = []
  const resolved = body.cart_items.map((item) => {
    const product = productById.get(item.product_id)
    if (!product) throw badRequest('checkout:UNKNOWN_PRODUCT', item.product_id)

    const mods = item.modifiers.map((selected) => {
      const modifier = modifierById.get(selected.modifier_id)
      if (!modifier) throw badRequest('checkout:UNKNOWN_MODIFIER', selected.modifier_id)
      return modifier
    })

    const modifierTotalSen = mods.reduce((sum, modifier) => sum + modifier.priceSen, 0)
    priceInputs.push({
      brandId: product.brandId,
      unitPriceSen: product.basePriceSen,
      modifierTotalSen,
      quantity: item.quantity,
      requestedLineDiscountSen: item.discount_sen,
    })

    return { product, mods, modifierTotalSen, quantity: item.quantity }
  })

  const priced = priceOrder(priceInputs, body.cart_discount_sen)

  // ---- Does the server's figure match what the cashier was shown? ----

  let needsReview = false
  let reviewReason: string | null = null

  // What actually gets written. For an online sale this is the server's own
  // pricing, full stop. For an offline sale it becomes what the customer paid,
  // with the server's figure kept beside it — see below.
  let recorded = priced
  let repriced = false

  if (priced.totalAmountSen !== body.claimed_total_sen) {
    if (body.origin === 'ONLINE') {
      throw badRequest(
        'checkout:GROSS_MISMATCH',
        `claimed ${body.claimed_total_sen} sen, server computed ${priced.totalAmountSen} sen`,
      )
    }

    /*
     * An offline tablet priced from a cached menu. The money has already moved,
     * so the books must record the amount that moved — not what the same basket
     * would cost today. Recording the current menu price here would book revenue
     * that never arrived and leave that shift permanently unreconcilable.
     *
     * So the device's own prices become the historical snapshot for this order,
     * and the server's recomputation is kept alongside as `menu_price_sen`. The
     * divergence is stored and reportable rather than discarded: a device
     * claiming implausible offline prices shows up in a report instead of being
     * silently trusted.
     *
     * The client is still not trusted on arithmetic. Its own basket has to add up
     * to the total it says it charged, or there is no coherent snapshot to record
     * and the sale is refused outright.
     */
    const chargedInputs: PricedLineInput[] = resolved.map((line, index) => {
      const item = body.cart_items[index]
      if (!item) throw badRequest('server:UNEXPECTED', 'cart item missing')
      return {
        brandId: line.product.brandId,
        unitPriceSen: item.charged_unit_price_sen ?? line.product.basePriceSen,
        modifierTotalSen: item.charged_modifier_total_sen ?? line.modifierTotalSen,
        quantity: item.quantity,
        requestedLineDiscountSen: item.discount_sen,
      }
    })

    const charged = priceOrder(chargedInputs, body.cart_discount_sen)
    if (charged.totalAmountSen !== body.claimed_total_sen) {
      throw badRequest(
        'checkout:OFFLINE_TOTAL_MISMATCH',
        `claimed ${body.claimed_total_sen} sen, but the prices sent add up to ${charged.totalAmountSen} sen`,
      )
    }

    recorded = charged
    repriced = true
  }

  if (lateSync) {
    // Not an approval queue — nothing waits on the owner. This exists because a
    // closed shift's totals just moved, which reopens its reconciliation below.
    needsReview = true
    reviewReason = 'Synced after the shift was closed.'
  }

  // ---- Write ----

  const businessDate = businessDateToUtc(body.business_date)
  const queueNumber = await allocateQueueNumber(tx, businessId, body.business_date)
  const now = new Date()

  const order = await tx.order.create({
    data: {
      businessId,
      shiftId: shift.id,
      businessDate,
      queueNumber,
      offlineLabel: body.offline_label ?? null,
      clientTxnId: body.client_txn_id,
      origin: body.origin,
      grossSen: recorded.grossSen,
      lineDiscountSen: recorded.lineDiscountSen,
      orderDiscountSen: recorded.orderDiscountSen,
      totalAmountSen: recorded.totalAmountSen,
      // Equal to the total for an online sale; different only when an offline
      // sale was priced against a menu that has since moved.
      menuPriceSen: priced.totalAmountSen,
      confirmedById: userId,
      confirmedAt: now,
      completedAt: now,
      needsReview,
      reviewReason,
      items: {
        create: resolved.map((line, index) => {
          const pricedLine = recorded.lines[index]
          if (!pricedLine) throw badRequest('server:UNEXPECTED', 'priced line missing')
          const item = body.cart_items[index]
          return {
            productId: line.product.id,
            brandId: line.product.brandId,
            categoryId: line.product.categoryId,
            productName: line.product.name,
            quantity: line.quantity,
            // The price this line was actually sold at: the catalogue price
            // online, what the device charged offline. Either way the stored
            // lines add up to the stored total, which `orders_total_adds_up`
            // enforces at the database level.
            unitPriceSen: repriced
              ? (item?.charged_unit_price_sen ?? line.product.basePriceSen)
              : line.product.basePriceSen,
            modifierTotalSen: repriced
              ? (item?.charged_modifier_total_sen ?? line.modifierTotalSen)
              : line.modifierTotalSen,
            lineDiscountSen: pricedLine.lineDiscountSen,
            allocatedOrderDiscountSen: pricedLine.allocatedOrderDiscountSen,
            modifiers: {
              create: line.mods.map((modifier) => ({
                modifierItemId: modifier.id,
                name: modifier.name,
                priceSen: modifier.priceSen,
                type: modifier.type,
              })),
            },
          }
        }),
      },
    },
    include: { items: { include: { modifiers: true } } },
  })

  // One revenue entry per brand on the order, so the ledger itself carries the
  // brand attribution the partner settlement is built on. A fully discounted
  // order writes none: no money moved, and the order row is the audit trail.
  const netByBrand = new Map<string, number>()
  recorded.lines.forEach((line) => {
    netByBrand.set(line.brandId, (netByBrand.get(line.brandId) ?? 0) + line.netSen)
  })

  for (const [brandId, netSen] of netByBrand) {
    if (netSen <= 0) continue
    await tx.ledgerEntry.create({
      data: {
        businessId,
        businessDate,
        direction: 'MONEY_IN',
        amountSen: netSen,
        category: 'REVENUE',
        description: `Sale ${queueNumber}`,
        brandId,
        orderId: order.id,
        shiftId: shift.id,
      },
    })
  }

  // Keep the closed shift's stored takings true, and mark it changed-after-close.
  // No bank figure was declared at close, so there is no variance to recompute.
  if (lateSync) {
    await tx.shift.update({
      where: { id: shift.id },
      data: {
        systemNetSalesSen: (shift.system_net_sales_sen ?? 0) + order.totalAmountSen,
        reconciliationStatus: 'UNRECONCILED',
      },
    })
  }

  return serialise(order, false)
}
