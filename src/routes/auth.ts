import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { attemptLimitConfig, type AttemptOptions } from '../attempts.ts'
import { OWNER_SESSION_TTL, verifySecret } from '../auth.ts'
import { prisma } from '../db.ts'
import { unauthorized } from '../errors.ts'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * Which app is signing in. The business has one account; this decides what
   * the session can reach. Defaults to the narrower of the two.
   */
  scope: z.enum(['COUNTER', 'OWNER']).default('COUNTER'),
})

export async function authRoutes(app: FastifyInstance, options: AttemptOptions): Promise<void> {
  // At most 10 sign-in attempts per 15 minutes per client. The business has one
  // account, so this password is the whole business.
  app.post('/auth/login', { config: attemptLimitConfig(options) }, async (request) => {
    const { email, password, scope } = loginBody.parse(request.body)

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })

    // Same error whether the address is unknown or the password is wrong, so
    // the endpoint cannot be used to enumerate accounts. The hash comparison
    // still runs on a dummy value to keep the timing comparable.
    const hash = user?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv'
    const ok = await verifySecret(password, hash)

    if (!user || !user.isActive || !ok) {
      throw unauthorized('auth:INVALID_CREDENTIALS')
    }

    // Every token is tied to a session row, so the owner can revoke it from the
    // RMS and the revocation takes effect on the device's very next request.
    const session = await prisma.session.create({ data: { userId: user.id, scope } })
    const payload = { id: user.id, email: user.email, role: user.role, sid: session.id, scope }

    // A counter session never expires: the cashier only has the PIN, and the
    // tablet must not sign itself out mid-service. An owner session lasts a day.
    const token =
      scope === 'OWNER'
        ? app.jwt.sign(payload, { expiresIn: OWNER_SESSION_TTL })
        : app.jwt.sign(payload)

    return {
      token,
      scope,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    }
  })
}
