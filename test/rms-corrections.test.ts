import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import { DEMO, authed, checkoutPayload, login, loginOwner, makeApp, openShift, productByName, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let counter: string
let owner: string
let shiftId: string
const businessDate = getBusinessDate(new Date())

beforeAll(async () => {
  app = await makeApp()
  counter = await login(app)
  owner = await loginOwner(app)
})
afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})
beforeEach(async () => {
  await resetTransactional()
  shiftId = await openShift(app, counter)
})

/** 3 × Kopi Ais (RM5.50, RM1 off the line) and 1 × Ayam Goreng Berempah (RM8): RM23.50. */
async function sale() {
  const kopi = await productByName('Kopi Ais')
  const ayam = await productByName('Ayam Goreng Berempah')
  const response = await app.inject({
    method: 'POST',
    url: '/checkout',
    headers: authed(counter),
    payload: checkoutPayload({
      shiftId,
      businessDate,
      clientTxnId: randomUUID(),
      claimedTotalSen: 2350,
      items: [
        { product_id: kopi.id, quantity: 3, discount_sen: 100 },
        { product_id: ayam.id, quantity: 1 },
      ],
    }),
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().order_id as string
}

const ticket = async (orderId: string) =>
  (await app.inject({ method: 'GET', url: `/rms/orders/${orderId}/ticket`, headers: authed(owner) })).json()
const fix = (orderId: string, payload: Record<string, unknown>, token = owner) =>
  app.inject({ method: 'POST', url: `/rms/orders/${orderId}/corrections`, headers: authed(token), payload: { client_txn_id: randomUUID(), reason: 'Refund given at the counter, not keyed in', ...payload } })

describe('RMS sale fixes', () => {
  it('refunds an item the counter forgot to key in, on yesterday\'s closed shift', async () => {
    const orderId = await sale()
    const close = await app.inject({ method: 'POST', url: `/shifts/${shiftId}/close`, headers: authed(counter), payload: { pin: DEMO.pin } })
    expect(close.statusCode).toBe(200)

    expect((await ticket(orderId)).lines).toMatchObject([
      { line: 0, product_name: 'Kopi Ais', quantity: 3, net_sen: 1550 },
      { line: 1, product_name: 'Ayam Goreng Berempah', quantity: 1, net_sen: 800 },
    ])
    // One of three discounted coffees: a third of what was charged for the line.
    const refund = await fix(orderId, { refunds: [{ line: 0, quantity: 1 }], expected_refund_sen: 517 })
    expect(refund.statusCode, refund.body).toBe(200)
    expect(refund.json()).toMatchObject({ kind: 'EXCHANGE', delta_sen: -517 })

    expect(await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).toMatchObject({
      status: 'CLOSED',
      systemNetSalesSen: 2350 - 517,
      reconciliationStatus: 'UNRECONCILED',
    })
    const ledger = await prisma.ledgerEntry.findMany({ where: { orderId, category: 'REFUND' } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ direction: 'MONEY_OUT', amountSen: 517 })
    expect(ledger[0]!.description).toContain('Refund (RMS)')
    expect((await ticket(orderId)).lines).toMatchObject([
      { product_name: 'Kopi Ais', quantity: 2, net_sen: 1033 },
      { product_name: 'Ayam Goreng Berempah', quantity: 1, net_sen: 800 },
    ])
  })

  it('builds on earlier fixes and cancels once nothing is left', async () => {
    const orderId = await sale()
    expect((await fix(orderId, { refunds: [{ line: 1, quantity: 1 }], expected_refund_sen: 800 })).statusCode).toBe(200)
    expect((await ticket(orderId)).lines).toMatchObject([{ product_name: 'Kopi Ais', quantity: 3 }])

    const rest = await fix(orderId, { refunds: [{ line: 0, quantity: 3 }], expected_refund_sen: 1550 })
    expect(rest.json()).toMatchObject({ kind: 'CANCEL', delta_sen: -1550 })
    expect((await ticket(orderId)).lines).toEqual([])
    expect((await fix(orderId, { cancel: true, expected_refund_sen: 1 })).json().error).toBe('correction:ALREADY_CANCELLED')
    const refunded = await prisma.ledgerEntry.aggregate({ where: { orderId, category: 'REFUND' }, _sum: { amountSen: true } })
    expect(refunded._sum.amountSen).toBe(2350)
  })

  it('runs once per click, refuses a stale amount or too many, and stays off the counter', async () => {
    const orderId = await sale()
    const clientTxnId = randomUUID()
    const once = { client_txn_id: clientTxnId, cancel: true, expected_refund_sen: 2350 }
    const [a, b] = await Promise.all([fix(orderId, once), fix(orderId, once)])
    expect(a.json().correction_id).toBe(b.json().correction_id)
    expect(await prisma.saleCorrection.count({ where: { originalOrderId: orderId } })).toBe(1)

    const other = await sale()
    expect((await fix(other, { refunds: [{ line: 0, quantity: 1 }], expected_refund_sen: 500 })).json().error).toBe('correction:DELTA_MISMATCH')
    expect((await fix(other, { refunds: [{ line: 0, quantity: 4 }], expected_refund_sen: 1400 })).json().error).toBe('correction:REFUND_TOO_MANY')
    expect((await fix(other, { refunds: [{ line: 0, quantity: 1 }], expected_refund_sen: 517 }, counter)).statusCode).toBe(403)
    expect(await prisma.saleCorrection.count({ where: { originalOrderId: other } })).toBe(0)
  })
})
