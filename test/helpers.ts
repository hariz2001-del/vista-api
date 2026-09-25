import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/build-app.ts'
import { prisma } from '../src/db.ts'

// Whatever the seed was given. vitest.config.ts guarantees both are set.
export const DEMO = {
  email: 'demo@vistahub.my',
  password: process.env.SEED_PASSWORD as string,
  pin: process.env.SEED_PIN as string,
  /** The seeded demo business (prisma/seed.ts). */
  businessId: 'c1000000-0000-4000-8000-000000000001',
}

/**
 * Clear everything transactional but leave the demo catalogue alone — it is
 * seeded once by `npm run seed`, and tests assert against its real prices.
 * Businesses a test registered are removed entirely.
 */
export async function resetTransactional(): Promise<void> {
  await prisma.expense.deleteMany()
  await prisma.periodClosure.deleteMany()
  await prisma.terminalStatus.deleteMany()
  await prisma.ledgerEntry.deleteMany()
  await prisma.correctionBrandDelta.deleteMany()
  await prisma.saleCorrection.deleteMany()
  await prisma.orderItemModifier.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.queueCounter.deleteMany()
  await prisma.handoffCode.deleteMany()
  // Guessing limits live in the database now, so they outlast a test run.
  await prisma.attemptCounter.deleteMany()

  const others = { businessId: { not: DEMO.businessId } }
  await prisma.session.deleteMany({ where: others })
  await prisma.partner.deleteMany({ where: others })
  await prisma.modifierItem.deleteMany({ where: others })
  await prisma.modifierGroup.deleteMany({ where: others })
  await prisma.product.deleteMany({ where: others })
  await prisma.category.deleteMany({ where: others })
  await prisma.brand.deleteMany({ where: others })
  await prisma.accountSettings.deleteMany({ where: others })
  await prisma.user.deleteMany({ where: others })
  await prisma.business.deleteMany({ where: { id: { not: DEMO.businessId } } })
}

export async function makeApp(): Promise<FastifyInstance> {
  // The suites log in, open shifts and register businesses far more often than
  // the real limits allow; those are exercised on their own in attempts.test.ts.
  const app = await buildApp({ attemptLimit: 1_000, registrationLimit: 1_000 })
  await app.ready()
  return app
}

export type TestBusiness = {
  businessId: string
  email: string
  password: string
  pin: string
  /** A session as the RMS gets one: through the hub's handoff. */
  ownerToken: string
  /** A session as the POS gets one: through the hub's handoff. */
  counterToken: string
}

let registered = 0

/**
 * Register a second business the way a new owner does — vistahub.my's sign-up,
 * then a handoff to each app — so the tests exercise the real front door.
 */
export async function makeBusiness(
  app: FastifyInstance,
  name = `Test Business ${++registered}`,
): Promise<TestBusiness> {
  const email = `owner${registered}.${Date.now()}@example.test`
  const password = 'correct horse battery staple'
  const pin = '4321'

  const register = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { businessName: name, email, password, pin },
  })
  if (register.statusCode !== 200) {
    throw new Error(`register failed (${register.statusCode}): ${register.body}`)
  }
  const hubToken = (register.json() as { token: string }).token

  const handoff = async (target: 'POS' | 'RMS'): Promise<string> => {
    const minted = await app.inject({
      method: 'POST',
      url: '/auth/handoff',
      headers: authed(hubToken),
      payload: { target },
    })
    if (minted.statusCode !== 200) throw new Error(`handoff failed: ${minted.body}`)
    const redeemed = await app.inject({
      method: 'POST',
      url: '/auth/handoff/redeem',
      payload: { code: (minted.json() as { code: string }).code },
    })
    if (redeemed.statusCode !== 200) throw new Error(`redeem failed: ${redeemed.body}`)
    return (redeemed.json() as { token: string }).token
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return {
    businessId: user.businessId,
    email,
    password,
    pin,
    ownerToken: await handoff('RMS'),
    counterToken: await handoff('POS'),
  }
}

/** A counter session, as the POS signs in. Sales, corrections and shifts only. */
export async function login(app: FastifyInstance): Promise<string> {
  return loginAs(app, DEMO.email, DEMO.password, 'COUNTER')
}

/** The same single account, signed in the way the RMS does: an owner session. */
export async function loginOwner(app: FastifyInstance): Promise<string> {
  return loginAs(app, DEMO.email, DEMO.password, 'OWNER')
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
  scope: 'COUNTER' | 'OWNER' = 'COUNTER',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, scope },
  })
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`)
  }
  return (response.json() as { token: string }).token
}

export function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export async function openShift(
  app: FastifyInstance,
  token: string,
  pin: string = DEMO.pin,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/shifts/open',
    headers: authed(token),
    payload: { pin },
  })
  if (response.statusCode !== 200) {
    throw new Error(`open shift failed (${response.statusCode}): ${response.body}`)
  }
  return (response.json() as { id: string }).id
}

/** A seeded demo product. Other businesses' menus are never matched by name. */
export async function productByName(name: string) {
  const product = await prisma.product.findFirstOrThrow({
    where: { name, businessId: DEMO.businessId },
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
