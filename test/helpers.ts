import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { prisma } from '../src/db.ts'

export const DEMO = { email: 'demo@vistahub.my', password: 'vista', pin: '1234' }

/**
 * Clear everything transactional but leave the catalogue alone — the catalogue
 * is seeded once by `npm run seed`, and tests assert against its real prices.
 */
export async function resetTransactional(): Promise<void> {
  await prisma.ledgerEntry.deleteMany()
  await prisma.correctionBrandDelta.deleteMany()
  await prisma.saleCorrection.deleteMany()
  await prisma.orderItemModifier.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.queueCounter.deleteMany()
}

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp()
  await app.ready()
  return app
}

export async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: DEMO.email, password: DEMO.password },
  })
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`)
  }
  return (response.json() as { token: string }).token
}

export function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export async function openShift(app: FastifyInstance, token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/shifts/open',
    headers: authed(token),
    payload: { pin: DEMO.pin },
  })
  if (response.statusCode !== 200) {
    throw new Error(`open shift failed (${response.statusCode}): ${response.body}`)
  }
  return (response.json() as { id: string }).id
}

export async function productByName(name: string) {
  const product = await prisma.product.findFirstOrThrow({
    where: { name },
    include: { modifierGroups: { include: { items: true } } },
  })
  return product
}

/** A modifier item on a product, looked up by the label a cashier would tap. */
export async function modifierByName(productName: string, optionName: string) {
  const product = await productByName(productName)
  for (const group of product.modifierGroups) {
    const match = group.items.find((item) => item.name === optionName)
    if (match) return match
  }
  throw new Error(`No modifier "${optionName}" on "${productName}"`)
}

export type CheckoutLine = {
  product_id: string
  quantity: number
  discount_sen?: number
  modifiers?: Array<{ modifier_id: string }>
  /** What the device charged, for an offline sale priced against a stale menu. */
  charged_unit_price_sen?: number
  charged_modifier_total_sen?: number
}

export function checkoutPayload(input: {
  shiftId: string
  businessDate: string
  clientTxnId: string
  claimedTotalSen: number
  cartDiscountSen?: number
  origin?: 'ONLINE' | 'OFFLINE_SYNC'
  offlineLabel?: string
  items: CheckoutLine[]
}) {
  return {
    shift_id: input.shiftId,
    client_txn_id: input.clientTxnId,
    business_date: input.businessDate,
    origin: input.origin ?? 'ONLINE',
    offline_label: input.offlineLabel ?? null,
    claimed_total_sen: input.claimedTotalSen,
    cart_discount_sen: input.cartDiscountSen ?? 0,
    cart_items: input.items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      discount_sen: item.discount_sen ?? 0,
      modifiers: item.modifiers ?? [],
      charged_unit_price_sen: item.charged_unit_price_sen,
      charged_modifier_total_sen: item.charged_modifier_total_sen,
    })),
  }
}

export function correctionPayload(input: {
  clientTxnId: string
  originalClientTxnId: string
  kind: 'CANCEL' | 'EXCHANGE'
  reason?: string
  claimedDeltaSen: number
  origin?: 'ONLINE' | 'OFFLINE_SYNC'
  replacementCartDiscountSen?: number | null
  replacementItems?: CheckoutLine[] | null
}) {
  return {
    client_txn_id: input.clientTxnId,
    original_client_txn_id: input.originalClientTxnId,
    kind: input.kind,
    reason: input.reason ?? 'Cashier corrected the paid ticket',
    origin: input.origin ?? 'ONLINE',
    claimed_delta_sen: input.claimedDeltaSen,
    replacement_cart_discount_sen: input.replacementCartDiscountSen ?? null,
    replacement_items:
      input.replacementItems?.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        discount_sen: item.discount_sen ?? 0,
        modifiers: item.modifiers ?? [],
        charged_unit_price_sen: item.charged_unit_price_sen,
        charged_modifier_total_sen: item.charged_modifier_total_sen,
      })) ?? null,
  }
}
