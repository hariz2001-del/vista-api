import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../src/db.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

async function setup() {
  const business = await makeBusiness(app), owner = authed(business.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'chopper' } })).json().key
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId: '111', role: 'OWNER', name: 'owner' } })
  return { business, owner, relay: { authorization: 'Bearer ' + key, 'x-telegram-user': '111' } }
}

it('carries an owner message to Chopper and its answer, with a file, back once', async () => {
  const { owner, relay } = await setup()
  const sent = await app.inject({ method: 'POST', url: '/rms/chopper/chat', headers: owner, payload: { text: 'Sales yesterday?' } })
  expect(sent.statusCode, sent.body).toBe(200)
  const id = sent.json().id

  const claim = (await app.inject({ method: 'POST', url: '/agent/chopper/chat/claim', headers: relay })).json()
  expect(claim.message).toMatchObject({ id, text: 'Sales yesterday?', status: 'PENDING' })
  expect((await app.inject({ method: 'POST', url: '/agent/chopper/chat/claim', headers: relay })).json().message).toBeNull()

  const answer = { text: 'RM 1,284.50 from 96 orders.', files: [{ name: 'sales.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4 test').toString('base64') }] }
  expect((await app.inject({ method: 'POST', url: `/agent/chopper/chat/${id}/reply`, headers: relay, payload: answer })).json()).toMatchObject({ repeated: false })
  expect((await app.inject({ method: 'POST', url: `/agent/chopper/chat/${id}/reply`, headers: relay, payload: answer })).json()).toMatchObject({ repeated: true })

  const chat = (await app.inject({ method: 'GET', url: '/rms/chopper/chat', headers: owner })).json()
  expect(chat.messages.map((m: any) => [m.role, m.status])).toEqual([['owner', 'ANSWERED'], ['chopper', 'DONE']])
  expect(chat.messages[1]).toMatchObject({ text: 'RM 1,284.50 from 96 orders.', file: { name: 'sales.pdf' } })
  expect(chat.open).toHaveLength(0)
  const after = (await app.inject({ method: 'GET', url: `/rms/chopper/chat?after=${chat.messages[1].id}`, headers: owner })).json()
  expect(after.messages).toHaveLength(0)

  const file = await app.inject({ method: 'GET', url: `/rms/chopper/chat/${chat.messages[1].id}/file`, headers: owner })
  expect(file.statusCode).toBe(200)
  expect(file.headers['content-type']).toBe('application/pdf')
  expect(file.rawPayload.toString()).toBe('%PDF-1.4 test')
})

it('keeps each business’s chat to itself, and refuses the relay’s key to owners', async () => {
  const a = await setup(), b = await setup()
  await app.inject({ method: 'POST', url: '/rms/chopper/chat', headers: a.owner, payload: { text: 'Only for A' } })
  expect((await app.inject({ method: 'GET', url: '/rms/chopper/chat', headers: b.owner })).json().messages).toHaveLength(0)
  expect((await app.inject({ method: 'POST', url: '/agent/chopper/chat/claim', headers: b.relay })).json().message).toBeNull()
  expect((await app.inject({ method: 'GET', url: '/rms/chopper/chat', headers: a.relay })).statusCode).toBe(401)
})
