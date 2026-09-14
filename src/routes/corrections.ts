import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../auth.ts'
import { prisma, type Tx } from '../db.ts'
import { priceOrder, type PricedLineInput, type PricedOrder } from '../domain/cart.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

const modifierSchema = z.object({ modifier_id: z.string().uuid() })

const replacementItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  discount_sen: z.number().int().min(0).default(0),
  modifiers: z.array(modifierSchema).default([]),
  charged_unit_price_sen: z.number().int().min(0).optional(),
  charged_modifier_total_sen: z.number().int().min(0).optional(),
})

const correctionBody = z
  .object({
    client_txn_id: z.string().uuid(),
    original_client_txn_id: z.string().uuid(),
    kind: z.enum(['CANCEL', 'EXCHANGE']),
    reason: z.string().trim().min(1).max(240),
    origin: z.enum(['ONLINE', 'OFFLINE_SYNC']).default('ONLINE'),
    /** Positive means collect more; negative means return money. */
    claimed_delta_sen: z.number().int(),
    replacement_cart_discount_sen: z.number().int().min(0).nullish(),
    replacement_items: z.array(replacementItemSchema).min(1).nullish(),
  })
  .superRefine((body, context) => {
    if (
      body.kind === 'CANCEL' &&
      (body.replacement_items != null || body.replacement_cart_discount_sen != null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A cancellation cannot carry a replacement ticket.',
      })
    }
    if (body.kind === 'EXCHANGE' && body.replacement_items == null) {
      context.addIssue({ code: 'custom', message: 'An exchange requires a replacement ticket.' })
    }
  })

type CorrectionBody = z.infer<typeof correctionBody>
type ReplacementItem = NonNullable<CorrectionBody['replacement_items']>[number]

type ResolvedLine = {
  product: {
    id: string
    name: string
    brandId: string
    categoryId: string
    basePriceSen: number
  }
  modifiers: Array<{
    id: string
    name: string
    priceSen: number
    type: 'ADD_ON' | 'REMOVAL'
  }>
  quantity: number
  menuModifierTotalSen: number
}

async function loadExisting(client: Tx | typeof prisma, clientTxnId: string) {
  return client.saleCorrection.findUnique({
    where: { clientTxnId },
    include: { brandDeltas: true },
  })
}

function serialise(
  correction: NonNullable<Awaited<ReturnType<typeof loadExisting>>>,
  replayed: boolean,
) {
  return {
    correction_id: correction.id,
    original_order_id: correction.originalOrderId,
    kind: correction.kind,
    delta_sen: correction.deltaSen,
    replacement_total_sen: correction.replacementTotalSen,
    replacement_menu_price_sen: correction.replacementMenuPriceSen,
    brand_deltas: correction.brandDeltas.map((delta) => ({
      brand_id: delta.brandId,
      delta_sen: delta.deltaSen,
    })),
    replayed,
  }
}

function totalsByBrand(priced: PricedOrder): Map<string, number> {
  const totals = new Map<string, number>()
  for (const line of priced.lines) {
    totals.set(line.brandId, (totals.get(line.brandId) ?? 0) + line.netSen)
  }
  return totals
}

function signedTotal(totals: Map<string, number>): number {
  return [...totals.values()].reduce((sum, amount) => sum + amount, 0)
}

function differenceByBrand(
  before: Map<string, number>,
  after: Map<string, number>,
): Array<{ brandId: string; deltaSen: number }> {
  const ids = new Set([...before.keys(), ...after.keys()])
  return [...ids]
    .map((brandId) => ({
      brandId,
      deltaSen: (after.get(brandId) ?? 0) - (before.get(brandId) ?? 0),
    }))
    .filter(({ deltaSen }) => deltaSen !== 0)
}

async function priceReplacement(
  tx: Tx,
  items: ReplacementItem[],
  cartDiscountSen: number,
  origin: CorrectionBody['origin'],
  expectedTotalSen: number,
) {
  const productIds = [...new Set(items.map((item) => item.product_id))]
  const products = await tx.product.findMany({ where: { id: { in: productIds } } })
  const productById = new Map(products.map((product) => [product.id, product]))

  const modifierIds = [
    ...new Set(items.flatMap((item) => item.modifiers.map((modifier) => modifier.modifier_id))),
  ]
  const modifierItems = modifierIds.length
    ? await tx.modifierItem.findMany({
        where: { id: { in: modifierIds } },
        include: { group: { select: { productId: true } } },
      })
    : []
  const modifierById = new Map(modifierItems.map((modifier) => [modifier.id, modifier]))

  const resolved: ResolvedLine[] = items.map((item) => {
    const product = productById.get(item.product_id)
    if (!product) throw badRequest('checkout:UNKNOWN_PRODUCT', item.product_id)

    const selectedIds = new Set<string>()
    const modifiers = item.modifiers.map(({ modifier_id: modifierId }) => {
      if (selectedIds.has(modifierId)) {
        throw badRequest('checkout:UNKNOWN_MODIFIER', `duplicate ${modifierId}`)
      }
      selectedIds.add(modifierId)
      const modifier = modifierById.get(modifierId)
      if (!modifier || modifier.group.productId !== product.id) {
        throw badRequest('checkout:UNKNOWN_MODIFIER', modifierId)
      }
      return modifier
    })

    return {
      product,
      modifiers,
      quantity: item.quantity,
      menuModifierTotalSen: modifiers.reduce((sum, modifier) => sum + modifier.priceSen, 0),
    }
  })

  const menuInputs: PricedLineInput[] = resolved.map((line, index) => ({
    brandId: line.product.brandId,
    unitPriceSen: line.product.basePriceSen,
    modifierTotalSen: line.menuModifierTotalSen,
    quantity: line.quantity,
    requestedLineDiscountSen: items[index]?.discount_sen ?? 0,
  }))
  const menuPrice = priceOrder(menuInputs, cartDiscountSen)

  let recorded = menuPrice
  let usesChargedSnapshot = false
  if (menuPrice.totalAmountSen !== expectedTotalSen) {
    if (origin === 'ONLINE') {
      throw badRequest(
        'correction:TOTAL_MISMATCH',
        `replacement is ${menuPrice.totalAmountSen} sen, expected ${expectedTotalSen} sen`,
      )
    }

    const chargedInputs: PricedLineInput[] = resolved.map((line, index) => ({
      brandId: line.product.brandId,
      unitPriceSen: items[index]?.charged_unit_price_sen ?? line.product.basePriceSen,
      modifierTotalSen:
        items[index]?.charged_modifier_total_sen ?? line.menuModifierTotalSen,
      quantity: line.quantity,
      requestedLineDiscountSen: items[index]?.discount_sen ?? 0,
    }))
    const charged = priceOrder(chargedInputs, cartDiscountSen)
    if (charged.totalAmountSen !== expectedTotalSen) {
      throw badRequest(
        'correction:OFFLINE_TOTAL_MISMATCH',
        `replacement prices add up to ${charged.totalAmountSen} sen, expected ${expectedTotalSen} sen`,
      )
    }
    recorded = charged
    usesChargedSnapshot = true
  }

  const snapshot = resolved.map((line, index) => {
    const input = items[index]
    const pricedLine = recorded.lines[index]
    if (!input || !pricedLine) throw badRequest('server:UNEXPECTED', 'replacement line missing')
    return {
      product_id: line.product.id,
      product_name: line.product.name,
      brand_id: line.product.brandId,
      category_id: line.product.categoryId,
      quantity: line.quantity,
      unit_price_sen: usesChargedSnapshot
        ? (input.charged_unit_price_sen ?? line.product.basePriceSen)
        : line.product.basePriceSen,
      modifier_total_sen: usesChargedSnapshot
        ? (input.charged_modifier_total_sen ?? line.menuModifierTotalSen)
        : line.menuModifierTotalSen,
      discount_sen: pricedLine.lineDiscountSen,
      allocated_cart_discount_sen: pricedLine.allocatedOrderDiscountSen,
      modifiers: line.modifiers.map((modifier) => ({
        modifier_id: modifier.id,
        name: modifier.name,
        price_sen: modifier.priceSen,
        type: modifier.type,
      })),
    }
  })

  return { recorded, menuPrice, snapshot }
}

export async function correctionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/corrections', { preHandler: requireUser }, async (request) => {
    const body = correctionBody.parse(request.body)
    const existing = await loadExisting(prisma, body.client_txn_id)
    if (existing) return serialise(existing, true)

    try {
      return await prisma.$transaction((tx) => runCorrection(tx, body, request.user.id), {
        timeout: 15_000,
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await loadExisting(prisma, body.client_txn_id)
        if (winner) return serialise(winner, true)
      }
      throw error
    }
  })
}

async function runCorrection(tx: Tx, body: CorrectionBody, userId: string) {
  const replay = await loadExisting(tx, body.client_txn_id)
  if (replay) return serialise(replay, true)

  const orderRef = await tx.order.findUnique({
    where: { clientTxnId: body.original_client_txn_id },
    select: { id: true, shiftId: true },
  })
  if (!orderRef) throw notFound('correction:ORDER_NOT_FOUND')

  // Shift close takes this same lock. Corrections and close therefore cannot
  // cross after the declared total has been compared but before status changes.
  const shifts = await tx.$queryRaw<
    Array<{ id: string; status: string; system_net_sales_sen: number | null }>
  >`
    SELECT id, status, system_net_sales_sen
      FROM shifts WHERE id = ${orderRef.shiftId} FOR UPDATE
  `
  const shift = shifts[0]
  if (!shift) throw notFound('shift:NOT_FOUND')
  if (shift.status !== 'OPEN' && body.origin !== 'OFFLINE_SYNC') {
    throw conflict('correction:SHIFT_NOT_OPEN')
  }

  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderRef.id} FOR UPDATE`
  // A same-key request may have been waiting behind the first request's shift
  // lock. Re-check only after that lock is ours, before interpreting the first
  // correction as prior business history and accidentally returning "already cancelled".
  const replayAfterLock = await loadExisting(tx, body.client_txn_id)
  if (replayAfterLock) return serialise(replayAfterLock, true)

  const order = await tx.order.findUnique({
    where: { id: orderRef.id },
    include: {
      items: true,
      corrections: { include: { brandDeltas: true } },
    },
  })
  if (!order) throw notFound('correction:ORDER_NOT_FOUND')
  if (order.isLocked) throw conflict('correction:PERIOD_LOCKED')

  const before = new Map<string, number>()
  for (const item of order.items) {
    const net =
      (item.unitPriceSen + item.modifierTotalSen) * item.quantity -
      item.lineDiscountSen -
      item.allocatedOrderDiscountSen
    before.set(item.brandId, (before.get(item.brandId) ?? 0) + net)
  }
  for (const prior of order.corrections) {
    for (const delta of prior.brandDeltas) {
      before.set(delta.brandId, (before.get(delta.brandId) ?? 0) + delta.deltaSen)
    }
  }

  const beforeTotalSen = signedTotal(before)
  if (beforeTotalSen <= 0) throw conflict('correction:ALREADY_CANCELLED')

  let after = new Map<string, number>()
  let replacementItems: Prisma.InputJsonValue | Prisma.NullTypes.DbNull = Prisma.DbNull
  let replacementCartDiscountSen: number | null = null
  let replacementTotalSen: number | null = null
  let replacementMenuPriceSen: number | null = null

  if (body.kind === 'CANCEL') {
    if (body.claimed_delta_sen !== -beforeTotalSen) {
      throw badRequest(
        'correction:DELTA_MISMATCH',
        `claimed ${body.claimed_delta_sen} sen, server computed ${-beforeTotalSen} sen`,
      )
    }
  } else {
    const expectedTotalSen = beforeTotalSen + body.claimed_delta_sen
    if (expectedTotalSen < 0) {
      throw badRequest('correction:DELTA_MISMATCH', 'replacement total would be negative')
    }
    const priced = await priceReplacement(
      tx,
      body.replacement_items ?? [],
      body.replacement_cart_discount_sen ?? 0,
      body.origin,
      expectedTotalSen,
    )
    after = totalsByBrand(priced.recorded)
    replacementItems = priced.snapshot as Prisma.InputJsonValue
    replacementCartDiscountSen = body.replacement_cart_discount_sen ?? 0
    replacementTotalSen = priced.recorded.totalAmountSen
    replacementMenuPriceSen = priced.menuPrice.totalAmountSen
  }

  const brandDeltas = differenceByBrand(before, after)
  const deltaSen = signedTotal(after) - beforeTotalSen
  if (deltaSen !== body.claimed_delta_sen) {
    throw badRequest(
      'correction:DELTA_MISMATCH',
      `claimed ${body.claimed_delta_sen} sen, server computed ${deltaSen} sen`,
    )
  }

  const correction = await tx.saleCorrection.create({
    data: {
      clientTxnId: body.client_txn_id,
      originalOrderId: order.id,
      shiftId: order.shiftId,
      businessDate: order.businessDate,
      kind: body.kind,
      reason: body.reason,
      deltaSen,
      replacementItems,
      replacementCartDiscountSen,
      replacementTotalSen,
      replacementMenuPriceSen,
      createdById: userId,
      brandDeltas: { create: brandDeltas },
    },
    include: { brandDeltas: true },
  })

  for (const delta of brandDeltas) {
    await tx.ledgerEntry.create({
      data: {
        businessDate: order.businessDate,
        direction: delta.deltaSen > 0 ? 'MONEY_IN' : 'MONEY_OUT',
        amountSen: Math.abs(delta.deltaSen),
        category: delta.deltaSen > 0 ? 'REVENUE' : 'REFUND',
        description: `${body.kind === 'CANCEL' ? 'Cancel' : 'Exchange'} ${order.queueNumber}: ${body.reason}`,
        brandId: delta.brandId,
        orderId: order.id,
        shiftId: order.shiftId,
        correctionId: correction.id,
      },
    })
  }

  // A correction that arrives after close moves a total that was already
  // recorded. Keep the stored figure true, and mark the shift so the owner can
  // see its takings changed after the fact. There is no declared bank figure to
  // recompute a variance against — shift close no longer takes one.
  if (shift.status !== 'OPEN') {
    await tx.shift.update({
      where: { id: shift.id },
      data: {
        systemNetSalesSen: (shift.system_net_sales_sen ?? 0) + deltaSen,
        reconciliationStatus: 'UNRECONCILED',
      },
    })
  }

  return serialise(correction, false)
}
