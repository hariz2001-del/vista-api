import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { getBusinessDate } from '../src/domain/business-date.ts'
import { authed, checkoutPayload, DEMO, login, loginOwner, makeApp, openShift, productByName, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let owner: string
let counter: string
beforeAll(async () => { app = await makeApp(); owner = await loginOwner(app); counter = await login(app) })
beforeEach(resetTransactional)
afterAll(async () => { await app.close(); await prisma.$disconnect() })
const state = async () => {
  const response = await app.inject({ method: 'GET', url: '/rms/state', headers: authed(owner) })
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('private, no-store')
  return response.json()
}

it('returns a small stable owner-only fingerprint, not historical rows', async () => {
  const first = await state(), second = await state()
  expect(first.revision).toMatch(/^[a-f0-9]{32}$/)
  expect(second.revision).toBe(first.revision)
  expect(JSON.stringify(first).length).toBeLessThan(2000)
  expect(first.orders).toBeUndefined()
  expect((await app.inject({ method: 'GET', url: '/rms/state', headers: authed(counter) })).statusCode).toBe(403)
})

it('detects newly sold history and edits/deletes even when counts do not change', async () => {
  const shift = await openShift(app, counter)
  const before = await state()
  const product = await productByName('Ayam Goreng Berempah')
  const sale = await app.inject({ method: 'POST', url: '/checkout', headers: authed(counter), payload: checkoutPayload({
    shiftId: shift, businessDate: getBusinessDate(new Date()), clientTxnId: randomUUID(),
    claimedTotalSen: product.basePriceSen, items: [{ product_id: product.id, quantity: 1 }],
  }) })
  expect(sale.statusCode).toBe(200)
  const sold = await state(); expect(sold.revision).not.toBe(before.revision)
  const row = await prisma.order.findFirstOrThrow({ where: { businessId: DEMO.businessId } })
  await prisma.order.update({ where: { id: row.id }, data: { flagReason: 'fingerprint change test' } })
  const edited = await state(); expect(edited.revision).not.toBe(sold.revision)
  const ledger = await prisma.ledgerEntry.findFirstOrThrow({ where: { businessId: DEMO.businessId } })
  await prisma.ledgerEntry.delete({ where: { id: ledger.id } })
  expect((await state()).revision).not.toBe(edited.revision)
})

it('updates heartbeat separately without invalidating all history', async () => {
  const before = await state()
  await prisma.terminalStatus.upsert({ where: { businessId: DEMO.businessId },
    create: { businessId: DEMO.businessId, lastSeenAt: new Date() }, update: { lastSeenAt: new Date() } })
  const after = await state()
  expect(after.revision).toBe(before.revision)
  expect(after.terminal.lastSeenAt).not.toBeNull()
})
