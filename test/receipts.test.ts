import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import {
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

function receipts(date: string) {
  return app.inject({
    method: 'GET',
    url: `/receipts?business_date=${date}`,
    headers: authed(token),
  })
}

describe('receipts', () => {
  it('lists the day’s sales with their lines and corrections, for any tablet', async () => {
    const product = await productByName('Ayam Goreng Berempah') // 800
    const clientTxnId = randomUUID()
    await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: authed(token),
      payload: checkoutPayload({
        shiftId,
        businessDate,
        clientTxnId,
        claimedTotalSen: 800,
        items: [{ product_id: product.id, quantity: 1 }],
      }),
    })
    await app.inject({
      method: 'POST',
      url: '/corrections',
      headers: authed(token),
      payload: correctionPayload({
        clientTxnId: randomUUID(),
        originalClientTxnId: clientTxnId,
        kind: 'CANCEL',
        claimedDeltaSen: -800,
      }),
    })

    const response = await receipts(businessDate)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.orders).toHaveLength(1)
    expect(body.orders[0]).toMatchObject({
      client_txn_id: clientTxnId,
      shift_id: shiftId,
      queue_number: '#001',
      total_amount_sen: 800,
      cart_items: [{ product_id: product.id, product_name: 'Ayam Goreng Berempah', quantity: 1 }],
    })
    expect(body.corrections).toHaveLength(1)
    expect(body.corrections[0]).toMatchObject({
      original_client_txn_id: clientTxnId,
      kind: 'CANCEL',
      delta_sen: -800,
    })
  })

  it('is empty for a day with no sales', async () => {
    const response = await receipts('2001-01-01')
    expect(response.json()).toEqual({ orders: [], corrections: [] })
  })
})
