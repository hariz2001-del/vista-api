import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { businessDateToUtc, getBusinessDate } from '../src/domain/business-date.ts'
import {
  DEMO,
  authed,
  checkoutPayload,
  login,
  makeApp,
  openShift,
  productByName,
  resetTransactional,
} from './helpers.ts'

let app: FastifyInstance
let token: string
const businessDate = getBusinessDate(new Date())

beforeAll(async () => {
  app = await makeApp()
  token = await login(app)
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(resetTransactional)

type CloseRequest = { pin: string; device_pending_count?: number }

function close(shiftId: string, payload: CloseRequest) {
  return app.inject({
    method: 'POST',
    url: `/shifts/${shiftId}/close`,
    headers: authed(token),
    payload,
  })
}

describe('shift open', () => {
  it('refuses a wrong PIN', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/shifts/open',
      headers: authed(token),
      payload: { pin: '9999' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'auth:INVALID_PIN' })
  })

  it('refuses a second shift while one is open', async () => {
    await openShift(app, token)
    const response = await app.inject({
      method: 'POST',
      url: '/shifts/open',
      headers: authed(token),
      payload: { pin: DEMO.pin },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'shift:ALREADY_OPEN' })
  })

  it('is stopped by the database too, not only by the route', async () => {
    await openShift(app, token)

    // Bypass the route entirely — the constraint has to hold on its own.
    await expect(
      prisma.shift.create({
        data: {
          businessDate: businessDateToUtc(businessDate),
          status: 'OPEN',
          openedById: '10000000-0000-4000-8000-000000000001',
        },
      }),
    ).rejects.toThrow()
  })
})

describe('shift close', () => {
  it('computes takings itself from the ledger', async () => {
    const shiftId = await openShift(app, token)
    const product = await productByName('Ayam Goreng Berempah') // 800 sen

    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/checkout',
        headers: authed(token),
        payload: checkoutPayload({
          shiftId,
          businessDate,
          clientTxnId: randomUUID(),
          claimedTotalSen: 800,
          items: [{ product_id: product.id, quantity: 1 }],
        }),
      })
    }

    const response = await close(shiftId, { pin: DEMO.pin })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      order_count: 3,
      system_net_sales_sen: 2400,
      reconciliation_status: 'NOT_REQUIRED',
    })
  })

  it('records no bank figure and no variance at close', async () => {
    const shiftId = await openShift(app, token)
    const product = await productByName('Ayam Goreng Berempah')

    await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: authed(token),
      payload: checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 800,
        items: [{ product_id: product.id, quantity: 1 }],
      }),
    })

    // An older client may still send a declared figure. It is accepted and ignored.
    const response = await close(shiftId, {
      pin: DEMO.pin,
      declared_bank_total_sen: 750,
    } as CloseRequest)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      system_net_sales_sen: 800,
      reconciliation_status: 'NOT_REQUIRED',
    })

    const stored = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(stored.declaredBankTotalSen).toBeNull()
    expect(stored.varianceSen).toBeNull()

    // Nothing is absorbed into the ledger at close. A gap the owner finds later
    // is closed by Adjust Balance in the RMS, which writes its own entry.
    const adjustments = await prisma.ledgerEntry.count({
      where: { category: 'RECONCILIATION_ADJUSTMENT' },
    })
    expect(adjustments).toBe(0)
  })

  it('records takings net of discounts', async () => {
    const shiftId = await openShift(app, token)
    const product = await productByName('Ayam Goreng Berempah') // 800

    await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: authed(token),
      payload: checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId: randomUUID(),
        claimedTotalSen: 600,
        cartDiscountSen: 200,
        items: [{ product_id: product.id, quantity: 1 }],
      }),
    })

    // The bank received the discounted amount, so that is the figure recorded.
    const response = await close(shiftId, { pin: DEMO.pin })
    expect(response.json()).toMatchObject({ system_net_sales_sen: 600 })
  })

  it('refuses a second close', async () => {
    const shiftId = await openShift(app, token)
    await close(shiftId, { pin: DEMO.pin })

    const response = await close(shiftId, { pin: DEMO.pin })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'shift:ALREADY_CLOSED' })
  })

  it('refuses to close while the device still holds unsent sales', async () => {
    const shiftId = await openShift(app, token)

    const response = await close(shiftId, {
      pin: DEMO.pin,
      device_pending_count: 2,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'shift:UNSYNCED_ORDERS' })

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
    expect(shift.status).toBe('OPEN')
  })

  it('refuses a wrong PIN', async () => {
    const shiftId = await openShift(app, token)
    const response = await close(shiftId, { pin: '0000' })
    expect(response.statusCode).toBe(401)
  })
})
