import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { attemptLimitConfig, countAttempt, type AttemptOptions } from '../attempts.ts'
import { signSession, verifySecret } from '../auth.ts'
import { prisma } from '../db.ts'
import { DomainError, messageFor, notFound, unauthorized } from '../errors.ts'

/**
 * Staff sign-in for team.vistahub.my. Like the account sign-in in auth.ts,
 * these run before there is a session to say which business a request is for,
 * so they use the unscoped client and name the business in every query.
 */

const orgBody = z.object({
  /** The business account's email, or the organisation code from Team settings. */
  identifier: z.string().trim().min(1).max(254),
})

const loginBody = z.object({
  orgId: z.string().uuid(),
  /** Staff ID, or name. */
  who: z.string().trim().min(1).max(80),
  pin: z.string().regex(/^\d{4}$/),
})

/** Wrong PINs one staff member may take, from any number of phones. */
const STAFF_PIN_LIMIT = 5
const STAFF_PIN_WINDOW_MS = 15 * 60_000

/** Compared against when nobody matched, so a miss takes as long as a hit. */
const DUMMY_HASH = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv'

function staffPinKey(staffId: string): string {
  return `staff-pin ${staffId}`
}

async function isStaffLockedOut(staffId: string): Promise<boolean> {
  const row = await prisma.attemptCounter.findUnique({ where: { key: staffPinKey(staffId) } })
  return Boolean(row && row.resetAt > new Date() && row.count >= STAFF_PIN_LIMIT)
}

async function businessDisplayName(businessId: string): Promise<string> {
  const [settings, business] = await Promise.all([
    prisma.accountSettings.findUnique({ where: { businessId }, select: { businessName: true } }),
    prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
  ])
  return settings?.businessName ?? business?.name ?? 'Your workplace'
}

export async function teamAuthRoutes(app: FastifyInstance, options: AttemptOptions): Promise<void> {
  /**
   * Which business a phone belongs to, from its email or code. Answers with
   * that one business's name and id, and nothing about any other — there is
   * no list to browse. Limited like sign-in, so it cannot be used to sweep
   * through addresses.
   */
  app.post('/team/auth/org', { config: attemptLimitConfig(options) }, async (request) => {
    const { identifier } = orgBody.parse(request.body)

    let businessId: string | null = null
    if (identifier.includes('@')) {
      const user = await prisma.user.findUnique({
        where: { email: identifier.toLowerCase() },
        select: { businessId: true, isActive: true },
      })
      if (user?.isActive) businessId = user.businessId
    } else {
      const settings = await prisma.teamSettings.findUnique({
        where: { orgCode: identifier.toUpperCase() },
        select: { businessId: true },
      })
      businessId = settings?.businessId ?? null
    }
    if (!businessId) throw notFound('team:ORG_NOT_FOUND')

    return { orgId: businessId, name: await businessDisplayName(businessId) }
  })

  /**
   * Name (or Staff ID) and PIN. Two limits apply: the usual one per phone, and
   * one per staff member — five wrong PINs and that person is locked for 15
   * minutes whichever phones the guesses came from, because 10,000 PINs is not
   * many to spread across a few addresses.
   */
  app.post('/team/auth/login', { config: attemptLimitConfig(options) }, async (request) => {
    const body = loginBody.parse(request.body)

    const candidates = await prisma.staffMember.findMany({
      where: {
        businessId: body.orgId,
        status: 'ACTIVE',
        OR: [
          { staffCode: { equals: body.who, mode: 'insensitive' } },
          { name: { equals: body.who, mode: 'insensitive' } },
        ],
      },
      include: { credentials: { where: { kind: 'PIN' } } },
    })
    // A Staff ID is unique; a name might not be. A Staff ID match wins.
    const byCode = candidates.filter((staff) => staff.staffCode.toUpperCase() === body.who.toUpperCase())
    const matches = byCode.length > 0 ? byCode : candidates
    if (matches.length > 1) throw new DomainError('team:AMBIGUOUS_NAME', 409, messageFor('team:AMBIGUOUS_NAME'))
    const staff = matches[0]

    if (staff && (await isStaffLockedOut(staff.id))) {
      throw new DomainError('auth:TOO_MANY_ATTEMPTS', 429, messageFor('auth:TOO_MANY_ATTEMPTS'))
    }

    const hash = staff?.credentials[0]?.secretHash ?? DUMMY_HASH
    const ok = await verifySecret(body.pin, hash)
    if (!staff || !staff.credentials[0] || !ok) {
      if (staff) await countAttempt(staffPinKey(staff.id), STAFF_PIN_WINDOW_MS)
      throw unauthorized('team:INVALID_LOGIN')
    }
    await prisma.attemptCounter.deleteMany({ where: { key: staffPinKey(staff.id) } })

    // A staff session hangs off the business account it signed in under.
    const account = await prisma.user.findFirst({
      where: { businessId: staff.businessId, role: 'OWNER', isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!account) throw unauthorized('team:INVALID_LOGIN')

    const session = await prisma.session.create({
      data: { businessId: staff.businessId, userId: account.id, scope: 'STAFF', staffId: staff.id },
    })
    const token = signSession((payload, signOptions) => app.jwt.sign(payload, signOptions), {
      id: account.id,
      // The business account's address has no business on a staff phone.
      email: '',
      role: 'STAFF',
      sid: session.id,
      scope: 'STAFF',
    })

    return {
      token,
      staff: { id: staff.id, name: staff.name, staffCode: staff.staffCode },
      org: { id: staff.businessId, name: await businessDisplayName(staff.businessId) },
    }
  })
}
