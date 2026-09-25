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
 */
export type SessionScope = 'COUNTER' | 'OWNER' | 'HUB'

/** An owner session lasts a working day. A counter session has no expiry at all. */
export const OWNER_SESSION_TTL = '12h'
/** Long enough to pick an app, and to come back and pick the other one. */
export const HUB_SESSION_TTL = '30m'

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
  }
}

/** Sign a token for a new session row. Only the owner and hub sessions expire. */
export function signSession(
  sign: (payload: SessionUser, options?: { expiresIn: string }) => string,
  payload: SessionUser,
): string {
  if (payload.scope === 'OWNER') return sign(payload, { expiresIn: OWNER_SESSION_TTL })
  if (payload.scope === 'HUB') return sign(payload, { expiresIn: HUB_SESSION_TTL })
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
}

/**
 * The counter's routes: sales, corrections, shifts, the menu. A counter or an
 * owner session may call them. A hub session may not — it exists only to hand
 * the owner on to one of the two apps.
 */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await authenticate(request)
  if (request.user.scope === 'HUB') throw forbidden('auth:FORBIDDEN')
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
