import bcrypt from 'bcryptjs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { forbidden, unauthorized } from './errors.ts'

const ROUNDS = 10

export function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS)
}

export function verifySecret(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export type SessionUser = {
  id: string
  email: string
  role: string
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
 */
export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify()
  } catch {
    throw unauthorized('auth:UNAUTHORIZED')
  }
}

/**
 * Owner-only routes. The cashier's token is refused even though it is valid: a
 * tablet at the counter must never be able to read the partners' books or move
 * money outside a sale.
 */
export async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireUser(request, reply)
  if (request.user.role !== 'OWNER_FOOD' && request.user.role !== 'OWNER_DRINKS') {
    throw forbidden('auth:FORBIDDEN')
  }
}
