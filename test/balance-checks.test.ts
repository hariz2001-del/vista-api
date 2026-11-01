import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../src/db.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

it('records one bank balance per day, replaces it on a second save and removes it, without touching the ledger', async () => {
  const business = await makeBusiness(app), owner = authed(business.ownerToken)
  const ledgerCount = () => prisma.ledgerEntry.count({ where: { businessId: business.businessId } })
  const before = await ledgerCount()
  const checks = async () => (await app.inject({ method: 'GET', url: '/rms/snapshot', headers: owner })).json().balanceChecks

  const saved = await app.inject({ method: 'PUT', url: '/rms/balance-checks/2026-11-01', headers: owner, payload: { bankSen: 150000, note: 'Maybank app, 8am' } })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(await checks()).toEqual([{ businessDate: '2026-11-01', bankSen: 150000, cashSen: 0, note: 'Maybank app, 8am' }])

  expect((await app.inject({ method: 'PUT', url: '/rms/balance-checks/2026-11-01', headers: owner, payload: { bankSen: 149000, cashSen: 2000 } })).statusCode).toBe(200)
  expect(await checks()).toEqual([{ businessDate: '2026-11-01', bankSen: 149000, cashSen: 2000, note: null }])
  expect(await ledgerCount()).toBe(before)

  expect((await app.inject({ method: 'PUT', url: '/rms/balance-checks/2026-11-01', headers: owner, payload: { bankSen: -1 } })).statusCode).toBe(400)

  expect((await app.inject({ method: 'DELETE', url: '/rms/balance-checks/2026-11-01', headers: owner })).statusCode).toBe(200)
  expect(await checks()).toEqual([])
  expect((await app.inject({ method: 'DELETE', url: '/rms/balance-checks/2026-11-01', headers: owner })).statusCode).toBe(404)
})

it('keeps each business to its own checks', async () => {
  const mine = await makeBusiness(app), theirs = await makeBusiness(app)
  await app.inject({ method: 'PUT', url: '/rms/balance-checks/2026-11-01', headers: authed(theirs.ownerToken), payload: { bankSen: 999 } })

  expect((await app.inject({ method: 'DELETE', url: '/rms/balance-checks/2026-11-01', headers: authed(mine.ownerToken) })).statusCode).toBe(404)
  const snapshot = (await app.inject({ method: 'GET', url: '/rms/snapshot', headers: authed(mine.ownerToken) })).json()
  expect(snapshot.balanceChecks).toEqual([])
})
