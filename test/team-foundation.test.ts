import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { authed, makeApp, makeBusiness, resetTransactional, type TestBusiness } from './helpers.ts'

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetTransactional()
})

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
function call(token: string | null, method: Method, url: string, payload?: object) {
  return app.inject({
    method,
    url,
    ...(token ? { headers: authed(token) } : {}),
    ...(payload ? { payload } : {}),
  })
}

async function addStaff(b: TestBusiness, body: object) {
  const response = await call(b.ownerToken, 'POST', '/rms/team/staff', body)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { staff: { id: string; staffCode: string }; pin: string }
}

async function staffLogin(b: TestBusiness, who: string, pin: string) {
  return call(null, 'POST', '/team/auth/login', { orgId: b.businessId, who, pin })
}

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into))
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key)
      keysOf(inner, into)
    }
  }
  return into
}

const CONFIDENTIAL_KEYS = [
  'attributes',
  'reliability',
  'capability',
  'experience',
  'soloSuitability',
  'trainingStatus',
  'managementPriority',
  'notes',
  'extra',
  'explanation',
  'score',
  'weights',
  'engineWeights',
]

describe('team — staff and PINs', () => {
  it('creates staff with a random 4-digit PIN that is only ever stored hashed', async () => {
    const b = await makeBusiness(app)
    const { staff, pin } = await addStaff(b, { name: 'Aina' })

    expect(pin).toMatch(/^\d{4}$/)
    expect(staff.staffCode).toBe('S001')
    const credential = await prisma.staffCredential.findFirstOrThrow({ where: { staffId: staff.id } })
    expect(credential.secretHash).not.toContain(pin)
    expect(credential.secretHash).toMatch(/^\$2[aby]\$/)

    // The list never carries the PIN again.
    const list = await call(b.ownerToken, 'GET', '/rms/team/staff')
    expect(list.body).not.toContain(`"pin"`)
    expect(list.json().staff[0]).toMatchObject({ name: 'Aina', hasPin: true })
  })

  it('signs a staff member in by organisation, name or Staff ID, and PIN', async () => {
    const b = await makeBusiness(app)
    const { pin } = await addStaff(b, { name: 'Aina', staffCode: 's007' })

    const org = await call(null, 'POST', '/team/auth/org', { identifier: b.email.toUpperCase() })
    expect(org.statusCode).toBe(200)
    expect(org.json()).toEqual({ orgId: b.businessId, name: expect.any(String) })

    for (const who of ['aina', 'S007']) {
      const login = await staffLogin(b, who, pin)
      expect(login.statusCode, login.body).toBe(200)
      expect(login.json().staff).toMatchObject({ name: 'Aina', staffCode: 'S007' })
    }

    const wrong = await staffLogin(b, 'Aina', pin === '0000' ? '0001' : '0000')
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json().error).toBe('team:INVALID_LOGIN')
  })

  it('finds an organisation by its code, and says nothing about one that does not exist', async () => {
    const b = await makeBusiness(app)
    expect((await call(b.ownerToken, 'PUT', '/rms/team/settings', { orgCode: 'sarang' })).statusCode).toBe(200)

    const byCode = await call(null, 'POST', '/team/auth/org', { identifier: 'Sarang' })
    expect(byCode.json().orgId).toBe(b.businessId)

    const unknown = await call(null, 'POST', '/team/auth/org', { identifier: 'nobody@example.test' })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.body).not.toContain(b.businessId)
  })

  it('locks one staff member after five wrong PINs, from any address', async () => {
    const b = await makeBusiness(app)
    const { pin } = await addStaff(b, { name: 'Amir' })
    const wrongPin = pin === '1111' ? '2222' : '1111'

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await staffLogin(b, 'Amir', wrongPin)).statusCode).toBe(401)
    }
    // Even the right PIN is refused until the window passes.
    const locked = await staffLogin(b, 'Amir', pin)
    expect(locked.statusCode).toBe(429)
  })

  it('ends a staff member’s sessions when their PIN is reset or they are deactivated', async () => {
    const b = await makeBusiness(app)
    const { staff, pin } = await addStaff(b, { name: 'Sarah' })
    const token = (await staffLogin(b, 'Sarah', pin)).json().token as string
    expect((await call(token, 'GET', '/team/me')).statusCode).toBe(200)

    const reset = await call(b.ownerToken, 'POST', `/rms/team/staff/${staff.id}/pin`, {})
    expect(reset.json().pin).toMatch(/^\d{4}$/)
    expect((await call(token, 'GET', '/team/me')).statusCode).toBe(401)

    // The new PIN works; a typed one can be set too.
    const newPin = reset.json().pin as string
    const again = (await staffLogin(b, 'Sarah', newPin)).json().token as string
    await call(b.ownerToken, 'PATCH', `/rms/team/staff/${staff.id}`, { status: 'INACTIVE' })
    expect((await call(again, 'GET', '/team/me')).statusCode).toBe(401)
    expect((await staffLogin(b, 'Sarah', newPin)).statusCode).toBe(401)

    const set = await call(b.ownerToken, 'POST', `/rms/team/staff/${staff.id}/pin`, { pin: '2468' })
    expect(set.json().pin).toBe('2468')
  })

  it('keeps a staff session out of the counter, the RMS and other staff routes of another business', async () => {
    const b = await makeBusiness(app)
    const { pin } = await addStaff(b, { name: 'Aina' })
    const token = (await staffLogin(b, 'Aina', pin)).json().token as string

    expect((await call(token, 'GET', '/bootstrap')).statusCode).toBe(403)
    expect((await call(token, 'GET', '/rms/snapshot')).statusCode).toBe(403)
    expect((await call(token, 'GET', '/rms/team/staff')).statusCode).toBe(403)
    // And management sessions are not staff sessions.
    expect((await call(b.ownerToken, 'GET', '/team/me')).statusCode).toBe(403)
    expect((await call(b.counterToken, 'GET', '/team/me')).statusCode).toBe(403)
  })

  it('cannot sign in to one business with another business’s staff', async () => {
    const a = await makeBusiness(app)
    const b = await makeBusiness(app)
    const { pin } = await addStaff(a, { name: 'Aina' })
    const crossed = await staffLogin(b, 'Aina', pin)
    expect(crossed.statusCode).toBe(401)
  })
})

describe('team — looking up a PIN in the RMS', () => {
  it('shows the current PIN to management, records each look, and never stores it readable', async () => {
    const b = await makeBusiness(app)
    const { staff, pin } = await addStaff(b, { name: 'Aina' })

    const seen = await call(b.ownerToken, 'GET', `/rms/team/staff/${staff.id}/pin`)
    expect(seen.json()).toEqual({ pin, viewable: true })
    const credential = await prisma.staffCredential.findFirstOrThrow({ where: { staffId: staff.id } })
    expect(credential.secretSealed).not.toContain(pin)

    const reset = await call(b.ownerToken, 'POST', `/rms/team/staff/${staff.id}/pin`, { pin: '0042' })
    expect(reset.json().pin).toBe('0042')
    expect((await call(b.ownerToken, 'GET', `/rms/team/staff/${staff.id}/pin`)).json().pin).toBe('0042')

    const trail = await call(b.ownerToken, 'GET', '/rms/team/audit')
    expect(trail.json().entries.filter((entry: { action: string }) => entry.action === 'staff.pin_viewed')).toHaveLength(2)
    expect(trail.body).not.toContain('0042')
  })

  it('is closed to staff, the counter and other businesses', async () => {
    const a = await makeBusiness(app)
    const b = await makeBusiness(app)
    const { staff, pin } = await addStaff(a, { name: 'Aina' })
    const staffToken = (await staffLogin(a, 'Aina', pin)).json().token as string
    expect((await call(staffToken, 'GET', `/rms/team/staff/${staff.id}/pin`)).statusCode).toBe(403)
    expect((await call(a.counterToken, 'GET', `/rms/team/staff/${staff.id}/pin`)).statusCode).toBe(403)
    expect((await call(b.ownerToken, 'GET', `/rms/team/staff/${staff.id}/pin`)).statusCode).toBe(404)
  })

  it('says a PIN set before this cannot be shown, until it is reset', async () => {
    const b = await makeBusiness(app)
    const { staff } = await addStaff(b, { name: 'Aina' })
    await prisma.staffCredential.updateMany({ where: { staffId: staff.id }, data: { secretSealed: null } })
    expect((await call(b.ownerToken, 'GET', `/rms/team/staff/${staff.id}/pin`)).json()).toEqual({ pin: null, viewable: false })
  })
})

describe('team — confidential attributes', () => {
  it('stores management’s read of a staff member and never shows it to them', async () => {
    const b = await makeBusiness(app)
    const { staff, pin } = await addStaff(b, { name: 'Aina' })

    const saved = await call(b.ownerToken, 'PUT', `/rms/team/staff/${staff.id}/attributes`, {
      reliability: 4,
      soloSuitability: 'NOT_RECOMMENDED',
      managementPriority: 1,
      notes: 'Strong on the bar, not yet on her own',
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().staff.attributes).toMatchObject({ reliability: 4, soloSuitability: 'NOT_RECOMMENDED' })

    const login = await staffLogin(b, 'Aina', pin)
    const token = login.json().token as string
    for (const response of [login, await call(token, 'GET', '/team/me')]) {
      const keys = keysOf(response.json())
      for (const key of CONFIDENTIAL_KEYS) expect(keys.has(key), `${key} leaked`).toBe(false)
      expect(response.body).not.toContain('Strong on the bar')
    }
  })

  it('refuses scores outside 1–5 and priority outside −2…+2', async () => {
    const b = await makeBusiness(app)
    const { staff } = await addStaff(b, { name: 'Aina' })
    for (const body of [{ reliability: 6 }, { capability: 0 }, { managementPriority: 3 }]) {
      const response = await call(b.ownerToken, 'PUT', `/rms/team/staff/${staff.id}/attributes`, body)
      expect(response.statusCode).toBe(400)
    }
  })
})

describe('team — work types, settings and the audit trail', () => {
  it('keeps work types and rates per business, with unique names', async () => {
    const a = await makeBusiness(app)
    const b = await makeBusiness(app)
    const regular = await call(a.ownerToken, 'POST', '/rms/team/work-types', { name: 'Regular', rateSenPerHour: 700 })
    expect(regular.statusCode).toBe(200)
    expect((await call(a.ownerToken, 'POST', '/rms/team/work-types', { name: 'Regular', rateSenPerHour: 800 })).statusCode).toBe(409)
    expect((await call(b.ownerToken, 'POST', '/rms/team/work-types', { name: 'Regular', rateSenPerHour: 900 })).statusCode).toBe(200)

    const id = regular.json().workType.id as string
    // Another business cannot change it, or even see it.
    expect((await call(b.ownerToken, 'PATCH', `/rms/team/work-types/${id}`, { rateSenPerHour: 1 })).statusCode).toBe(404)
    const listB = await call(b.ownerToken, 'GET', '/rms/team/work-types')
    expect(listB.json().workTypes.map((w: { rateSenPerHour: number }) => w.rateSenPerHour)).toEqual([900])
  })

  it('has configurable settings, refusing a usual load above the maximum', async () => {
    const b = await makeBusiness(app)
    const defaults = await call(b.ownerToken, 'GET', '/rms/team/settings')
    expect(defaults.json().settings).toMatchObject({ applicationLimit: 10, payRoundingMinutes: 30 })

    const changed = await call(b.ownerToken, 'PUT', '/rms/team/settings', { applicationLimit: 12, withdrawalDeadlineHours: 48 })
    expect(changed.json().settings).toMatchObject({ applicationLimit: 12, withdrawalDeadlineHours: 48 })
    expect((await call(b.ownerToken, 'PUT', '/rms/team/settings', { assignmentTargetShifts: 9, assignmentMaxShifts: 8 })).statusCode).toBe(400)
  })

  it('records who did what, and the trail cannot be edited', async () => {
    const b = await makeBusiness(app)
    const { staff } = await addStaff(b, { name: 'Aina' })
    await call(b.ownerToken, 'POST', `/rms/team/staff/${staff.id}/pin`, {})

    const trail = await call(b.ownerToken, 'GET', '/rms/team/audit')
    expect(trail.json().entries.map((entry: { action: string }) => entry.action)).toEqual([
      'staff.pin_reset',
      'staff.created',
    ])
    // The PIN itself is never in the trail.
    expect(trail.body).not.toMatch(/"pin"\s*:/)

    await expect(prisma.teamAuditEntry.deleteMany({ where: { businessId: b.businessId } })).rejects.toThrow()
  })
})
