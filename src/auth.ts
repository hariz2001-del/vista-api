import bcrypt from 'bcryptjs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from './db.ts'
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
 * What a session may reach. The business has one account; the scope is decided
 * by which app signed in, not by who.
 *
 *  - COUNTER — the tablet: sales, corrections, shifts. Never expires, because
 *    the cashier only ever has the PIN. It is revoked from the RMS instead.
 *  - OWNER — the dashboard: everything, including the books. Expires.
 */
export type SessionScope = 'COUNTER' | 'OWNER'

/** An owner session lasts a working day. A counter session has no expiry at all. */
export const OWNER_SESSION_TTL = '12h'

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

/**
 * Identity always comes from the verified token, never from anything in the
 * request body. A user id in a payload is a suggestion, not a credential.
 *
 * A valid signature is not enough on its own: the token's session row must
 * still be live. Signing the counter out from the RMS revokes that row, so the
 * tablet's very next request is refused — which is what sends it back to its
 * sign-in screen.
 */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    throw unauthorized('auth:UNAUTHORIZED')
  }

  const { sid, id } = request.user
  // A token from before sessions existed carries no session id. Refuse it.
  if (!sid) throw unauthorized('auth:UNAUTHORIZED')

  const session = await prisma.session.findUnique({ where: { id: sid } })
  if (!session || session.revokedAt !== null || session.userId !== id) {
    throw unauthorized('auth:UNAUTHORIZED')
  }

  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await prisma.session.update({ where: { id: sid }, data: { lastUsedAt: new Date() } })
  }
}

/**
 * Owner-only routes. A counter session is refused even though its token is
 * valid: a tablet at the counter must never be able to read the partners' books
 * or move money outside a sale — including one that has been stolen.
 */
export async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply)
  if (request.user.scope !== 'OWNER') throw forbidden('auth:FORBIDDEN')
}
