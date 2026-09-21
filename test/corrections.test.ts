import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import {
  DEMO,
  authed,
  checkoutPayload,
  correctionPayload,
  login,
  makeApp,
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

async function makeSale(productName: string, totalSen: number) {
  const product = await productByName(productName)
  const clientTxnId = randomUUID()
  const response = await app.inject({
    method: 'POST',
    url: '/checkout',
    headers: authed(token),
    payload: checkoutPayload({
      shiftId,
      businessDate,
      clientTxnId,
      claimedTotalSen: totalSen,
      items: [{ product_id: product.id, quantity: 1 }],
    }),
  })
  expect(response.statusCode).toBe(200)
  return { product, clientTxnId, orderId: response.json().order_id as string }
}

async function correct(payload: ReturnType<typeof correctionPayload>) {
  return app.inject({
    method: 'POST',
    url: '/corrections',
    headers: authed(token),
    payload,
  })
}

describe('paid-sale corrections', () => {
  it('cancels with a separate refund entry and leaves the paid order untouched', async () => {
    const sale = await makeSale('Ayam Goreng Berempah', 800)

    const response = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: sale.clientTxnId,
        kind: 'CANCEL',
        reason: 'Customer cancelled after paying',
        claimedDeltaSen: -800,
      }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ kind: 'CANCEL', delta_sen: -800, replayed: false })

    const original = await prisma.order.findUniqueOrThrow({ where: { id: sale.orderId } })
    expect(original.totalAmountSen).toBe(800)
    expect(original.paymentStatus).toBe('MANUALLY_CONFIRMED')

    const refund = await prisma.ledgerEntry.findFirstOrThrow({
      where: { correctionId: response.json().correction_id as string },
    })
    expect(refund).toMatchObject({
      direction: 'MONEY_OUT',
      category: 'REFUND',
      amountSen: 800,
      orderId: sale.orderId,
    })
  })

  it('is idempotent on the correction key, including concurrent retries', async () => {
    const sale = await makeSale('Ayam Goreng Berempah', 800)
    const payload = correctionPayload({
      clientTxnId: randomUUID(),
      originalClientTxnId: sale.clientTxnId,
      kind: 'CANCEL',
      claimedDeltaSen: -800,
    })

    const [first, second] = await Promise.all([correct(payload), correct(payload)])

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(first.json().correction_id).toBe(second.json().correction_id)
    expect(await prisma.saleCorrection.count()).toBe(1)
    expect(await prisma.ledgerEntry.count({ where: { category: 'REFUND' } })).toBe(1)
  })

  it('rejects a client-computed refund that disagrees with the server', async () => {
    const sale = await makeSale('Ayam Goreng Berempah', 800)
    const response = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: sale.clientTxnId,
        kind: 'CANCEL',
        claimedDeltaSen: -900,
      }),
    )

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'correction:DELTA_MISMATCH' })
    expect(await prisma.saleCorrection.count()).toBe(0)
  })

  it('exchanges down, then cancels only the amount still outstanding', async () => {
    const original = await makeSale('Nasi Lemak Ayam', 1200)
    const replacement = await productByName('Ayam Goreng Berempah') // 800

    const exchange = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'EXCHANGE',
        claimedDeltaSen: -400,
        replacementCartDiscountSen: 0,
        replacementItems: [{ product_id: replacement.id, quantity: 1 }],
      }),
    )
    expect(exchange.statusCode).toBe(200)
    expect(exchange.json()).toMatchObject({
      kind: 'EXCHANGE',
      delta_sen: -400,
      replacement_total_sen: 800,
    })

    const cancel = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'CANCEL',
        claimedDeltaSen: -800,
      }),
    )
    expect(cancel.statusCode).toBe(200)
    expect(cancel.json()).toMatchObject({ kind: 'CANCEL', delta_sen: -800 })

    const entries = await prisma.ledgerEntry.findMany({ where: { orderId: original.orderId } })
    const net = entries.reduce(
      (sum, entry) => sum + (entry.direction === 'MONEY_IN' ? entry.amountSen : -entry.amountSen),
      0,
    )
    expect(net).toBe(0)
  })

  it('moves a same-price exchange between brands without losing attribution', async () => {
    const original = await makeSale('Ayam Goreng Berempah', 800)
    const coconut = await productByName('Air Kelapa Muda') // Drinks, also 800

    const response = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'EXCHANGE',
        reason: 'Swapped for a different item',
        claimedDeltaSen: 0,
        replacementCartDiscountSen: 0,
        replacementItems: [{ product_id: coconut.id, quantity: 1 }],
      }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.json().brand_deltas).toHaveLength(2)
    expect(response.json().brand_deltas.map((delta: { delta_sen: number }) => delta.delta_sen).sort()).toEqual([
      -800, 800,
    ])

    const entries = await prisma.ledgerEntry.findMany({
      where: { correctionId: response.json().correction_id as string },
    })
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.direction).sort()).toEqual(['MONEY_IN', 'MONEY_OUT'])
  })

  it('accepts a coherent stale-price offline exchange and keeps both totals', async () => {
    const original = await makeSale('Ayam Goreng Berempah', 800)
    const kopi = await productByName('Kopi Ais') // menu 550, device charged 500

    const response = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'EXCHANGE',
        origin: 'OFFLINE_SYNC',
        claimedDeltaSen: -300,
        replacementCartDiscountSen: 0,
        replacementItems: [
          { product_id: kopi.id, quantity: 1, charged_unit_price_sen: 500 },
        ],
      }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      delta_sen: -300,
      replacement_total_sen: 500,
      replacement_menu_price_sen: 550,
    })
  })

  it('includes corrections in the server-computed shift total', async () => {
    const original = await makeSale('Nasi Lemak Ayam', 1200)
    const replacement = await productByName('Ayam Goreng Berempah')
    await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'EXCHANGE',
        claimedDeltaSen: -400,
        replacementCartDiscountSen: 0,
        replacementItems: [{ product_id: replacement.id, quantity: 1 }],
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/close`,
      headers: authed(token),
      payload: { pin: DEMO.pin },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      system_net_sales_sen: 800,
      reconciliation_status: 'NOT_REQUIRED',
    })
  })

  it('accepts a queued correction after close and keeps the stored takings true', async () => {
    const original = await makeSale('Ayam Goreng Berempah', 800)
    const close = await app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/close`,
      headers: authed(token),
      payload: { pin: DEMO.pin },
    })
    expect(close.statusCode).toBe(200)

    const kopi = await productByName('Kopi Ais')
    const response = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'EXCHANGE',
        origin: 'OFFLINE_SYNC',
        claimedDeltaSen: -300,
        replacementCartDiscountSen: 0,
        replacementItems: [
          { product_id: kopi.id, quantity: 1, charged_unit_price_sen: 500 },
        ],
      }),
    )
    expect(response.statusCode).toBe(200)

    const reopened = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(reopened).toMatchObject({
      status: 'CLOSED',
      systemNetSalesSen: 500,
      // No bank figure was ever declared, so there is still nothing to compare.
      varianceSen: null,
      reconciliationStatus: 'UNRECONCILED',
    })
  })

  it('refuses a new online correction after the shift is closed', async () => {
    const original = await makeSale('Ayam Goreng Berempah', 800)
    await app.inject({
      method: 'POST',
      url: `/shifts/${shiftId}/close`,
      headers: authed(token),
      payload: { pin: DEMO.pin },
    })

    const response = await correct(
      correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: original.clientTxnId,
        kind: 'CANCEL',
        claimedDeltaSen: -800,
      }),
    )

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'correction:SHIFT_NOT_OPEN' })
    expect(await prisma.saleCorrection.count()).toBe(0)
  })
})
