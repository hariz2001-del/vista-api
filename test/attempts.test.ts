import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/build-app.ts'
import { prisma } from '../src/db.ts'
import { authed, DEMO } from './helpers.ts'

/**
 * The real guessing limit: 10 attempts per 15 minutes per client. Built with
 * the production default, unlike every other suite.
 */

let app: FastifyInstance

beforeAll(async () => {
  // Counts are kept in the database, so a run within the last 15 minutes would
  // otherwise start these clients already blocked.
  await prisma.attemptCounter.deleteMany()
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

/**
 * Each test guesses from its own address, so one test's block cannot leak into
 * another. On Vercel this header is set by the platform, never by the client.
 */
function from(address: string) {
  return { 'x-forwarded-for': address }
}

function signIn(password: string, address: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: from(address),
    payload: { email: DEMO.email, password, scope: 'COUNTER' },
  })
}

describe('guessing limits', () => {
  it('stops password guessing after 10 attempts, even for the right password', async () => {
    const address = '203.0.113.10'
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await signIn('wrong-password', address)).statusCode).toBe(401)
    }

    const blocked = await signIn('wrong-password', address)
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ error: 'auth:TOO_MANY_ATTEMPTS' })

    // Until the window passes, the real password gets the same answer.
    expect((await signIn(DEMO.password, address)).statusCode).toBe(429)

    // Another client is unaffected.
    expect((await signIn(DEMO.password, '203.0.113.11')).statusCode).toBe(200)
  })

  it('stops PIN guessing after 10 attempts', async () => {
    const address = '203.0.113.20'
    const login = await signIn(DEMO.password, address)
    const token = (login.json() as { token: string }).token

    // Other suites share this database and may leave a shift open, so compare
    // against where it started rather than assuming zero.
    const openBefore = await prisma.shift.count({ where: { status: 'OPEN' } })

    const guess = () =>
      app.inject({
        method: 'POST',
        url: '/shifts/open',
        headers: { ...authed(token), ...from(address) },
        payload: { pin: '0000' },
      })

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await guess()
      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ error: 'auth:INVALID_PIN' })
    }

    const blocked = await guess()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toMatchObject({ error: 'auth:TOO_MANY_ATTEMPTS' })
    // Nothing was opened by any of it.
    expect(await prisma.shift.count({ where: { status: 'OPEN' } })).toBe(openBefore)
  })
})
