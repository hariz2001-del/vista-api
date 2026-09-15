import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import {
  authed,
  checkoutPayload,
  login,
  makeApp,
  modifierByName,
  openShift,
  productByName,
  resetTransactional,
} from './helpers.ts'

let app: FastifyInstance
let token: string
let shiftId: string
const businessDate = getBusinessDate(new Date())

beforeAll(async () => {
  app = await makeApp()
  token = await login(app)
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetTransactional()
  shiftId = await openShift(app, token)
})

type CheckoutRequest = ReturnType<typeof checkoutPayload>

async function checkout(payload: CheckoutRequest) {
  return app.inject({ method: 'POST', url: '/checkout', headers: authed(token), payload })
}

describe('checkout — pricing', () => {
  it('prices from the catalogue and ignores what the client claims it costs', async () => {
    const nasiLemak = await productByName('Nasi Lemak Ayam') // 1200 sen
    const sambal = await modifierByName('Nasi Lemak Ayam', 'Extra Sambal') // 150 sen

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 1350,
        items: [
          { product_id: nasiLemak.id, quantity: 1, modifiers: [{ modifier_id: sambal.id }] },
        ],
      }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      total_amount_sen: 1350,
      queue_number: '#001',
      needs_review: false,
      replayed: false,
    })
  })

  it('rejects an online order whose total disagrees with the menu', async () => {
    const nasiLemak = await productByName('Nasi Lemak Ayam')

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 1, // "one sen, please"
        items: [{ product_id: nasiLemak.id, quantity: 1 }],
      }),
    )

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'checkout:GROSS_MISMATCH' })
    expect(await prisma.order.count()).toBe(0)
  })

  it('cannot be told a modifier is cheaper than it is', async () => {
    const kopi = await productByName('Kopi Ais') // 550
    const large = await modifierByName('Kopi Ais', 'Large') // 150
    const shot = await modifierByName('Kopi Ais', 'Extra Shot') // 250

    // The request carries only modifier ids, so there is no price for a client
    // to lie about — the server reads all three from the catalogue.
    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 950,
        items: [
          {
            product_id: kopi.id,
            quantity: 1,
            modifiers: [{ modifier_id: large.id }, { modifier_id: shot.id }],
          },
        ],
      }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.json().total_amount_sen).toBe(950)
  })

  it('attributes an order discount across brands so the parts sum to the whole', async () => {
    const nasiLemak = await productByName('Nasi Lemak Ayam') // Food, 1200
    const kopi = await productByName('Kopi Ais') // Drinks, 550

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 1650, // 1750 gross − 100 order discount
        cartDiscountSen: 100,
        items: [
          { product_id: nasiLemak.id, quantity: 1 },
          { product_id: kopi.id, quantity: 1 },
        ],
      }),
    )

    expect(response.statusCode).toBe(200)

    const items = await prisma.orderItem.findMany({ include: { brand: true } })
    const allocated = items.reduce((sum, item) => sum + item.allocatedOrderDiscountSen, 0)
    expect(allocated).toBe(100)

    // Every sen lands on a brand, and no brand goes negative.
    for (const item of items) {
      const net =
        (item.unitPriceSen + item.modifierTotalSen) * item.quantity -
        item.lineDiscountSen -
        item.allocatedOrderDiscountSen
      expect(net).toBeGreaterThanOrEqual(0)
    }
  })

  it('writes one revenue ledger entry per brand, summing to the order total', async () => {
    const nasiLemak = await productByName('Nasi Lemak Ayam')
    const kopi = await productByName('Kopi Ais')

    await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 1750,
        items: [
          { product_id: nasiLemak.id, quantity: 1 },
          { product_id: kopi.id, quantity: 1 },
        ],
      }),
    )

    const entries = await prisma.ledgerEntry.findMany({ where: { category: 'REVENUE' } })
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.direction === 'MONEY_IN')).toBe(true)
    expect(entries.every((entry) => entry.brandId !== null)).toBe(true)
    expect(entries.reduce((sum, entry) => sum + entry.amountSen, 0)).toBe(1750)
  })
})

describe('checkout — idempotency', () => {
  it('returns the original order when the same key is replayed', async () => {
    const product = await productByName('Ayam Goreng Berempah') // 800
    const clientTxnId = randomUUID()
    const payload = checkoutPayload({
      shiftId,
      businessDate,
      clientTxnId,
      claimedTotalSen: 800,
      items: [{ product_id: product.id, quantity: 1 }],
    })

    const first = await checkout(payload)
    const second = await checkout(payload)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json().order_id).toBe(first.json().order_id)
    expect(second.json().replayed).toBe(true)

    expect(await prisma.order.count()).toBe(1)
    // The money must not be counted twice either.
    expect(await prisma.ledgerEntry.count()).toBe(1)
  })

  it('creates exactly one order when the same key arrives twice at once', async () => {
    const product = await productByName('Ayam Goreng Berempah')
    const payload = checkoutPayload({
      shiftId,
      businessDate,
      clientTxnId: randomUUID(),
      claimedTotalSen: 800,
      items: [{ product_id: product.id, quantity: 1 }],
    })

    const [a, b] = await Promise.all([checkout(payload), checkout(payload)])

    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(a.json().order_id).toBe(b.json().order_id)
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.ledgerEntry.count()).toBe(1)
  })
})

describe('checkout — queue numbers', () => {
  it('allocates sequentially from #001 with no duplicates under concurrency', async () => {
    const product = await productByName('Ayam Goreng Berempah')

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        checkout(
          checkoutPayload({
            shiftId,
            businessDate,
            clientTxnId: randomUUID(),
            claimedTotalSen: 800,
            items: [{ product_id: product.id, quantity: 1 }],
          }),
        ),
      ),
    )

    expect(responses.every((response) => response.statusCode === 200)).toBe(true)

    const numbers = responses.map((response) => response.json().queue_number as string).sort()
    expect(new Set(numbers).size).toBe(8)
    expect(numbers).toEqual([
      '#001', '#002', '#003', '#004', '#005', '#006', '#007', '#008',
    ])
  })
})

describe('checkout — offline sync', () => {
  it('records what the customer paid, not what the menu says now', async () => {
    const product = await productByName('Ayam Goreng Berempah') // now 800

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 750, // what the cached menu said last night
        origin: 'OFFLINE_SYNC',
        offlineLabel: '#OFF-01',
        items: [{ product_id: product.id, quantity: 1, charged_unit_price_sen: 750 }],
      }),
    )

    expect(response.statusCode).toBe(200)
    const body = response.json()
    // The money that actually moved is what gets booked. Recording 800 here
    // would invent 50 sen of revenue the bank never received.
    expect(body.total_amount_sen).toBe(750)
    // The server's own figure is kept beside it, so the drift is reportable.
    expect(body.menu_price_sen).toBe(800)
    // Nothing waits on the owner: a completed sale is not a decision.
    expect(body.needs_review).toBe(false)
    // And the number the kitchen was actually told survives.
    expect(body.offline_label).toBe('#OFF-01')
  })

  it('books the stored lines so they add up to the price charged', async () => {
    const product = await productByName('Ayam Goreng Berempah') // now 800
    const clientTxnId = randomUUID()

    await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId,
        claimedTotalSen: 1500,
        origin: 'OFFLINE_SYNC',
        items: [{ product_id: product.id, quantity: 2, charged_unit_price_sen: 750 }],
      }),
    )

    const order = await prisma.order.findUniqueOrThrow({
      where: { clientTxnId },
      include: { items: true },
    })

    expect(order.totalAmountSen).toBe(1500)
    expect(order.items[0]?.unitPriceSen).toBe(750)
    // The header has to be derivable from the lines, which is what
    // `orders_total_adds_up` enforces in the database.
    const grossSen = order.items.reduce(
      (sum, item) => sum + (item.unitPriceSen + item.modifierTotalSen) * item.quantity,
      0,
    )
    expect(grossSen - order.lineDiscountSen - order.orderDiscountSen).toBe(order.totalAmountSen)

    // The ledger follows the money that moved, not the menu.
    const revenue = await prisma.ledgerEntry.findMany({
      where: { orderId: order.id, category: 'REVENUE' },
    })
    expect(revenue.reduce((sum, entry) => sum + entry.amountSen, 0)).toBe(1500)
  })

  it('refuses an offline sale whose own prices do not add up to what it claims', async () => {
    const product = await productByName('Ayam Goreng Berempah')

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 100, // not what 750 x 1 comes to
        origin: 'OFFLINE_SYNC',
        items: [{ product_id: product.id, quantity: 1, charged_unit_price_sen: 750 }],
      }),
    )

    // Trusting the device on its own prices is not the same as trusting it on
    // arithmetic. Without a coherent snapshot there is nothing safe to record.
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('checkout:OFFLINE_TOTAL_MISMATCH')
  })

  it('accepts a sale that syncs after its shift closed, and reopens reconciliation', async () => {
    const product = await productByName('Ayam Goreng Berempah')

    await app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/close`,
      headers: authed(token),
      payload: { pin: '1234' },
    })
    const closed = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(closed.status).toBe('CLOSED')
    expect(closed.reconciliationStatus).toBe('NOT_REQUIRED')

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 800,
        origin: 'OFFLINE_SYNC',
        offlineLabel: '#OFF-02',
        items: [{ product_id: product.id, quantity: 1 }],
      }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.json().review_reason).toContain('closed')

    const reopened = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(reopened.reconciliationStatus).toBe('UNRECONCILED')
    expect(reopened.systemNetSalesSen).toBe(800)
    // Nothing was declared at close, so there is still no variance to recompute.
    expect(reopened.varianceSen).toBeNull()
  })

  it('refuses an online sale into a closed shift', async () => {
    const product = await productByName('Ayam Goreng Berempah')

    await app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/close`,
      headers: authed(token),
      payload: { pin: '1234' },
    })

    const response = await checkout(
      checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 800,
        items: [{ product_id: product.id, quantity: 1 }],
      }),
    )

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'checkout:SHIFT_NOT_OPEN' })
  })
})

describe('checkout — auth', () => {
  it('refuses an unauthenticated request', async () => {
    const product = await productByName('Ayam Goreng Berempah')
    const response = await app.inject({
      method: 'POST',
      url: '/checkout',
      payload: checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 800,
        items: [{ product_id: product.id, quantity: 1 }],
      }),
    })

    expect(response.statusCode).toBe(401)
    expect(await prisma.order.count()).toBe(0)
  })
})
