import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../src/db.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

it('records a partner withdrawal as one drawing line, changes it in place and removes it', async () => {
  const business = await makeBusiness(app), owner = authed(business.ownerToken)
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: business.businessId }, orderBy: { sortOrder: 'asc' } })
  const partner = await prisma.partner.create({ data: { businessId: business.businessId, name: 'Kirko', brandId: brand.id, role: 'FOOD_OWNER' } })
  const lines = () => prisma.ledgerEntry.findMany({ where: { businessId: business.businessId } })

  const made = await app.inject({ method: 'POST', url: '/rms/drawings', headers: owner, payload: { businessDate: '2026-10-19', amountSen: 50000, partnerId: partner.id, note: 'Rent at home' } })
  expect(made.statusCode, made.body).toBe(200)
  expect((await lines()).map((l) => [l.category, l.direction, l.amountSen, l.brandId, l.description])).toEqual([['OWNER_DRAWING', 'MONEY_OUT', 50000, brand.id, 'Withdrawal · Kirko — Rent at home']])

  const id = made.json().id
  expect((await app.inject({ method: 'PUT', url: `/rms/drawings/${id}`, headers: owner, payload: { businessDate: '2026-10-20', amountSen: 40000, partnerId: null } })).statusCode).toBe(200)
  expect((await lines()).map((l) => [l.amountSen, l.brandId, l.description])).toEqual([[40000, null, 'Withdrawal · Owner']])

  // Only withdrawals: another kind of line cannot be changed this way.
  const sale = await prisma.ledgerEntry.create({ data: { businessId: business.businessId, businessDate: new Date('2026-10-20'), direction: 'MONEY_IN', amountSen: 100, category: 'REVENUE', description: 'Sale' } })
  expect((await app.inject({ method: 'DELETE', url: `/rms/drawings/${sale.id}`, headers: owner })).statusCode).toBe(404)

  expect((await app.inject({ method: 'DELETE', url: `/rms/drawings/${id}`, headers: owner })).statusCode).toBe(200)
  expect((await lines()).map((l) => l.category)).toEqual(['REVENUE'])
})
