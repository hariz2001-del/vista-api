import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { authed, login, loginOwner, makeApp } from './helpers.ts'

/**
 * One account, two kinds of session. The counter tablet signs in once and stays
 * signed in; it can sell but not open the books. The owner dashboard signs in
 * with the same account and can do everything, including signing the counter out.
 */

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

/** The claims inside a JWT, without verifying it — only to read `exp`. */
function claims(token: string): Record<string, unknown> {
  const body = token.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
}

function bootstrap(token: string) {
  return app.inject({ method: 'GET', url: '/bootstrap', headers: authed(token) })
}

describe('sessions', () => {
  it('never expires a counter session, but does expire an owner session', async () => {
    const counter = claims(await login(app))
    const owner = claims(await loginOwner(app))

    expect(counter.scope).toBe('COUNTER')
    expect(counter.exp).toBeUndefined()
    expect(owner.scope).toBe('OWNER')
    expect(typeof owner.exp).toBe('number')
  })

  it('signs the counter out from the dashboard, and only the counter', async () => {
    const counterToken = await login(app)
    const ownerToken = await loginOwner(app)
    expect((await bootstrap(counterToken)).statusCode).toBe(200)

    const signOut = await app.inject({
      method: 'POST',
      url: '/rms/counter/sign-out',
      headers: authed(ownerToken),
    })
    expect(signOut.statusCode).toBe(200)
    expect((signOut.json() as { signedOut: number }).signedOut).toBeGreaterThan(0)

    // The tablet's next request is refused as signed out — which is what sends
    // it back to its sign-in screen.
    const refused = await bootstrap(counterToken)
    expect(refused.statusCode).toBe(401)
    expect(refused.json()).toMatchObject({ error: 'auth:UNAUTHORIZED' })

    // The dashboard itself stays signed in.
    const snapshot = await app.inject({
      method: 'GET',
      url: '/rms/snapshot',
      headers: authed(ownerToken),
    })
    expect(snapshot.statusCode).toBe(200)
    expect((snapshot.json() as { counterSessions: unknown[] }).counterSessions).toEqual([])

    // And the counter can be signed in again.
    expect((await bootstrap(await login(app))).statusCode).toBe(200)
  })

  it('refuses a token whose session no longer exists', async () => {
    const token = await login(app)
    await prisma.session.deleteMany({ where: { id: claims(token).sid as string } })

    expect((await bootstrap(token)).statusCode).toBe(401)
  })

  it('does not let a counter session sign the counter out', async () => {
    const counterToken = await login(app)
    const response = await app.inject({
      method: 'POST',
      url: '/rms/counter/sign-out',
      headers: authed(counterToken),
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('partners', () => {
  it('renames a partner from the dashboard', async () => {
    const ownerToken = await loginOwner(app)
    const hariz = await prisma.partner.findFirstOrThrow({ where: { role: 'FOOD_OWNER' } })
    try {
      const response = await app.inject({
        method: 'PUT',
        url: `/rms/partners/${hariz.id}`,
        headers: authed(ownerToken),
        payload: { name: 'Hariz bin Ahmad' },
      })
      expect(response.statusCode).toBe(200)

      const renamed = await prisma.partner.findUniqueOrThrow({ where: { id: hariz.id } })
      expect(renamed.name).toBe('Hariz bin Ahmad')

      const empty = await app.inject({
        method: 'PUT',
        url: `/rms/partners/${hariz.id}`,
        headers: authed(ownerToken),
        payload: { name: '   ' },
      })
      expect(empty.statusCode).toBe(400)
    } finally {
      await prisma.partner.update({ where: { id: hariz.id }, data: { name: hariz.name } })
    }
  })
})
