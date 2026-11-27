import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { authed, makeApp, makeBusiness } from './helpers.ts'
import { prisma } from '../src/db.ts'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

async function setup() {
  const b = await makeBusiness(app), headers = authed(b.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'sib' } })).json().key
  for (const [id, role] of [['111', 'OWNER'], ['222', 'BOOKKEEPER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId: id, role, name: role } })
  const agent = (user = '111') => ({ authorization: `Bearer ${key}`, 'x-telegram-user': user })
  const post = (url: string, payload: object, user = '111') => app.inject({ method: 'POST', url, payload, headers: agent(user) })
  const campaign = await prisma.campaign.create({ data: { businessId: b.businessId, name: 'SIB', status: 'ACTIVE' } })
  const transfer = async (payload: object, confirm: object = {}) => {
    const p = await post('/agent/campaign-transfers/preview', { businessDate: '2026-11-22', campaignId: campaign.id, wallet: 'TNG', ...payload })
    if (p.statusCode !== 200) return p
    return post('/agent/campaign-transfers/confirm', { confirmationId: p.json().confirmationId, ...confirm })
  }
  return { b, headers, agent, post, campaign, transfer }
}

it('SIB money that left the stall bank makes the closing tally without becoming a sale or an expense', async () => {
  const s = await setup()
  // Bank held RM1,000.00 after 21/11. On 22/11 Vista booked a verified SIB pre-order of RM72
  // as revenue, but the customer paid SIB's TNG, and RM72 more was moved from the bank to TNG.
  await app.inject({ method: 'POST', url: '/rms/balance-checks', headers: s.headers, payload: { businessDate: '2026-11-21', bankSen: 100000 } })
  await prisma.ledgerEntry.create({ data: { businessId: s.b.businessId, businessDate: new Date('2026-11-22T00:00:00Z'), direction: 'MONEY_IN', amountSen: 7200, category: 'REVENUE', description: 'SIB pre-order' } })
  const closing = { businessDate: '2026-11-22', salesSen: 7200, expensesSen: 0, otherOutflowsSen: 14400, openingBankSen: 100000, closingBankSen: 92800, statedTotalSen: 92800 }

  const before = (await s.post('/agent/closing/preview', closing)).json()
  expect(before.lines.otherOutflows).toMatchObject({ closingSen: 14400, vistaSen: 0, differenceSen: 14400 })
  expect(before.lines.closingBank).toMatchObject({ shortSen: -14400, differenceDirection: 'SHORT' })
  await s.post('/agent/closing/confirm', { confirmationId: before.confirmationId })

  const campaigns = (await app.inject({ method: 'GET', url: '/agent/campaigns', headers: s.agent() })).json().campaigns
  expect(campaigns.map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([[s.campaign.id, 'SIB']])
  // Only the owner; only a campaign of this business.
  expect((await s.post('/agent/campaign-transfers/preview', { businessDate: '2026-11-22', campaignId: s.campaign.id, kind: 'MOVED_TO_WALLET', amountSen: 7200, description: 'x' }, '222')).statusCode).toBe(403)
  const other = await setup()
  expect((await other.transfer({ campaignId: s.campaign.id, kind: 'MOVED_TO_WALLET', amountSen: 7200, description: 'x' })).statusCode).toBe(404)

  const moved = await s.transfer({ kind: 'MOVED_TO_WALLET', amountSen: 7200, description: 'Pre-order money to SIB wallet' })
  expect(moved.statusCode, moved.body).toBe(200)
  const paid = await s.transfer({ kind: 'PAID_INTO_WALLET', amountSen: 7200, description: 'Pre-order paid to TNG, not GX' })
  expect(paid.statusCode, paid.body).toBe(200)

  // Same campaign, kind, date and amount is refused unless the owner says it is separate.
  expect((await s.transfer({ kind: 'MOVED_TO_WALLET', amountSen: 7200, description: 'again' })).statusCode).toBe(409)
  const extra = await s.transfer({ kind: 'MOVED_TO_WALLET', amountSen: 7200, description: 'a second, separate move' }, { separateFromExisting: true })
  expect(extra.statusCode, extra.body).toBe(200)
  // Confirming the same preview twice books it once.
  const twice = await s.post('/agent/campaign-transfers/preview', { businessDate: '2026-11-23', campaignId: s.campaign.id, kind: 'RECEIVED_IN_BANK', amountSen: 100, description: 'replay check' })
  const first = await s.post('/agent/campaign-transfers/confirm', { confirmationId: twice.json().confirmationId })
  const again = await s.post('/agent/campaign-transfers/confirm', { confirmationId: twice.json().confirmationId })
  expect([first.json().replayed, again.json().replayed]).toEqual([false, true])
  await s.post(`/agent/campaign-transfers/${first.json().transferId}/reverse`, { reason: 'test only' })
  // Undo the extra one: its ledger row goes, the record stays as REVERSED.
  const undo = await s.post(`/agent/campaign-transfers/${extra.json().transferId}/reverse`, { reason: 'Entered twice' })
  expect(undo.statusCode, undo.body).toBe(200)

  const status = (await app.inject({ method: 'GET', url: '/agent/closing/status?date=2026-11-22', headers: s.agent() })).json().closings[0]
  expect(status.detail.comparison.lines.otherOutflows).toMatchObject({ closingSen: 14400, vistaSen: 14400, differenceSen: 0 })
  expect(status.detail.comparison.lines.closingBank).toMatchObject({ shortSen: 0, differenceDirection: 'BALANCED' })
  expect(status.detail.comparison.lines.sales.differenceSen).toBe(0)
  expect(status.detail.flags).not.toContain('BANK_DIFFERENCE')
  expect(status.detail.flags).not.toContain('OTHER_OUTFLOW_DIFFERENCE')

  const ledger = await prisma.ledgerEntry.findMany({ where: { businessId: s.b.businessId, category: 'CAMPAIGN_TRANSFER' } })
  expect(ledger.map(e => [e.direction, e.amountSen])).toEqual([['MONEY_OUT', 7200], ['MONEY_OUT', 7200]])
  expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(0)
  const list = (await app.inject({ method: 'GET', url: '/agent/campaign-transfers?from=2026-11-22&to=2026-11-22', headers: s.agent() })).json()
  expect(list.transfers.map((t: { status: string }) => t.status).sort()).toEqual(['RECORDED', 'RECORDED', 'REVERSED'])
})

it('campaign money landing in the stall bank counts as another inflow, not sales', async () => {
  const s = await setup()
  await app.inject({ method: 'POST', url: '/rms/balance-checks', headers: s.headers, payload: { businessDate: '2026-11-21', bankSen: 100000 } })
  const r = await s.transfer({ kind: 'RECEIVED_IN_BANK', amountSen: 4800, description: 'SIB pre-orders paid to GX' })
  expect(r.statusCode, r.body).toBe(200)
  const p = (await s.post('/agent/closing/preview', { businessDate: '2026-11-22', salesSen: 0, expensesSen: 0, otherInflowsSen: 4800, closingBankSen: 104800 })).json()
  expect(p.lines.otherInflows).toMatchObject({ closingSen: 4800, vistaSen: 4800, differenceSen: 0 })
  expect(p.lines.sales).toMatchObject({ vistaSen: 0, differenceSen: 0 })
  expect(p.lines.closingBank.shortSen).toBe(0)
})
