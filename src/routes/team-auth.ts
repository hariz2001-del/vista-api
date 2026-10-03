import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { attemptLimitConfig, countAttempt, type AttemptOptions } from '../attempts.ts'
import { signSession } from '../auth.ts'
import { prisma } from '../db.ts'
import { DomainError, messageFor, notFound, unauthorized } from '../errors.ts'
import { pinMatches } from '../team/pins.ts'

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
  /** Older app versions still send a name; the PIN alone decides now. */
  who: z.string().max(80).optional(),
  pin: z.string().regex(/^\d{4}$/),
})

/**
 * Wrong PINs one business may take, from any number of phones. The PIN is the
 * whole sign-in, so this caps how fast anyone can sweep the 10,000 of them —
 * at the price that a determined guesser can make everyone wait 15 minutes.
 */
const ORG_PIN_LIMIT = 20
const ORG_PIN_WINDOW_MS = 15 * 60_000

function orgPinKey(businessId: string): string {
  return `staff-pin-org ${businessId}`
}

async function isOrgLockedOut(businessId: string): Promise<boolean> {
  const row = await prisma.attemptCounter.findUnique({ where: { key: orgPinKey(businessId) } })
  return Boolean(row && row.resetAt > new Date() && row.count >= ORG_PIN_LIMIT)
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
   * The PIN alone. Every PIN in a business is different (pins.ts), so it says
   * who is signing in. Two limits apply: the usual one per phone, and one per
   * business across all phones.
   */
  app.post('/team/auth/login', { config: attemptLimitConfig(options) }, async (request) => {
    const body = loginBody.parse(request.body)
    if (await isOrgLockedOut(body.orgId)) {
      throw new DomainError('auth:TOO_MANY_ATTEMPTS', 429, messageFor('auth:TOO_MANY_ATTEMPTS'))
    }

    const credentials = await prisma.staffCredential.findMany({
      where: { businessId: body.orgId, kind: 'PIN', staff: { status: 'ACTIVE' } },
      include: { staff: true },
    })
    const matches = await pinMatches(credentials, body.pin)
    if (matches.length === 0) {
      await countAttempt(orgPinKey(body.orgId), ORG_PIN_WINDOW_MS)
      throw unauthorized('team:INVALID_LOGIN')
    }
    // Only possible for PINs given out before they had to differ.
    if (matches.length > 1) throw new DomainError('team:PIN_SHARED', 409, messageFor('team:PIN_SHARED'))
    const staff = matches[0]!.staff

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
