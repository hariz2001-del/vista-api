import bcrypt from 'bcryptjs'
import type { PrismaClient } from '@prisma/client'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { forBusiness, prisma } from './db.ts'
import { forbidden, unauthorized } from './errors.ts'

const ROUNDS = 10
/** How often a session's last-used time is written. Once a minute is plenty. */
const TOUCH_EVERY_MS = 60_000

export function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS)
}

export function verifySecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/**
 * What a session may reach. Each business has one account; the scope is
 * decided by which app signed in, not by who.
 *
 *  - COUNTER — the tablet: sales, corrections, shifts. Never expires, because
 *    the cashier only ever has the PIN. It is revoked from the RMS instead.
 *  - OWNER — the dashboard: everything, including the books. Expires.
 *  - HUB — vistahub.my between signing in and choosing an app. It can mint a
 *    handoff code and nothing else, and expires in minutes.
 *  - STAFF — one staff member on team.vistahub.my: their own roster,
 *    applications, attendance and pay, through /team routes only.
 */
export type SessionScope = 'COUNTER' | 'OWNER' | 'HUB' | 'STAFF'

/** An owner session lasts a working day. A counter session has no expiry at all. */
export const OWNER_SESSION_TTL = '12h'
/** Long enough to pick an app, and to come back and pick the other one. */
export const HUB_SESSION_TTL = '30m'
/** A staff phone stays signed in for a month; a PIN reset ends it at once. */
export const STAFF_SESSION_TTL = '30d'

export type SessionUser = {
  id: string
  email: string
  role: string
  /** The session row this token belongs to. Checked on every request. */
  sid: string
  scope: SessionScope
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser
    user: SessionUser
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The business this request acts for. Read from the session row, never the request. */
    businessId: string
    /** The database as that business sees it (src/db.ts). */
    db: PrismaClient
    /** Set for a STAFF session only: the staff member, from the session row. */
    staffId: string | undefined
  }
}

/** Sign a token for a new session row. Only the owner and hub sessions expire. */
export function signSession(
  sign: (payload: SessionUser, options?: { expiresIn: string }) => string,
  payload: SessionUser,
): string {
  if (payload.scope === 'OWNER') return sign(payload, { expiresIn: OWNER_SESSION_TTL })
  if (payload.scope === 'HUB') return sign(payload, { expiresIn: HUB_SESSION_TTL })
  if (payload.scope === 'STAFF') return sign(payload, { expiresIn: STAFF_SESSION_TTL })
  return sign(payload)
}

/**
 * Identity always comes from the verified token, never from anything in the
 * request body. A user id in a payload is a suggestion, not a credential.
 *
 * A valid signature is not enough on its own: the token's session row must
 * still be live. Signing the counter out from the RMS revokes that row, so the
 * tablet's very next request is refused — which is what sends it back to its
 * sign-in screen.
 *
 * The session row is also where the business comes from. Every route below
 * this reads and writes through `request.db`, which is fixed to that business.
 */
async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    throw unauthorized('auth:UNAUTHORIZED')
  }

  const { sid, id } = request.user
  // A token from before sessions existed carries no session id. Refuse it.
  if (!sid) throw unauthorized('auth:UNAUTHORIZED')

  const session = await prisma.session.findUnique({ where: { id: sid } })
  if (
    !session ||
    session.revokedAt !== null ||
    session.userId !== id ||
    session.scope !== request.user.scope
  ) {
    throw unauthorized('auth:UNAUTHORIZED')
  }

  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.session.update({ where: { id: sid }, data: { lastUsedAt: new Date() } })
  }

  request.businessId = session.businessId
  request.db = forBusiness(session.businessId)
  request.staffId = session.staffId ?? undefined
}

/**
 * The counter's routes: sales, corrections, shifts, the menu. A counter or an
 * owner session may call them. Nothing else may: a hub session exists only to
 * hand the owner on to an app, and a staff session only ever reaches /team.
 */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(request)
  if (request.user.scope !== 'COUNTER' && request.user.scope !== 'OWNER') {
    throw forbidden('auth:FORBIDDEN')
  }
}

/**
 * Owner-only routes. A counter session is refused even though its token is
 * valid: a tablet at the counter must never be able to read the partners' books
 * or move money outside a sale — including one that has been stolen.
 */
export async function requireOwner(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(request)
  if (request.user.scope !== 'OWNER') throw forbidden('auth:FORBIDDEN')
}

/** The hub's one route: minting a handoff code. */
export async function requireHub(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(request)
  if (request.user.scope !== 'HUB') throw forbidden('auth:FORBIDDEN')
}

/**
 * A staff member's own routes on team.vistahub.my. The staff member is the one
 * on the session row, and must still be active: deactivating someone in the
 * RMS shuts their phone out on its next request.
 */
export async function requireStaff(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(request)
  if (request.user.scope !== 'STAFF' || !request.staffId) throw forbidden('auth:FORBIDDEN')
  const staff = await request.db.staffMember.findUnique({
    where: { id: request.staffId },
    select: { status: true },
  })
  if (!staff || staff.status !== 'ACTIVE') throw unauthorized('auth:UNAUTHORIZED')
}

/**
 * What management can do in the Team module. Checked on the server for every
 * route; the RMS hiding a button is a convenience, never the control.
 *
 * Today only the business account signs in to the RMS, and it holds all of
 * them. Manager logins, when they come, get a subset — and no route changes.
 */
export type TeamPermission =
  | 'staff.manage'
  | 'staff.confidential'
  | 'roster.manage'
  | 'coverage.manage'
  | 'attendance.review'
  | 'payroll.process'
  | 'payroll.pay'
  | 'audit.view'

export function permissionsFor(scope: SessionScope): ReadonlySet<TeamPermission> {
  if (scope !== 'OWNER') return new Set()
  return new Set<TeamPermission>([
    'staff.manage',
    'staff.confidential',
    'roster.manage',
    'coverage.manage',
    'attendance.review',
    'payroll.process',
    'payroll.pay',
    'audit.view',
  ])
}

/** A preHandler for a management route that needs `permission`. */
export function requirePermission(permission: TeamPermission) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireOwner(request, reply)
    if (!permissionsFor(request.user.scope).has(permission)) throw forbidden('auth:FORBIDDEN')
  }
}
