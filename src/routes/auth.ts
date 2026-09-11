import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verifySecret } from '../auth.ts'
import { prisma } from '../db.ts'
import { unauthorized } from '../errors.ts'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request) => {
    const { email, password } = loginBody.parse(request.body)

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })

    // Same error whether the address is unknown or the password is wrong, so
    // the endpoint cannot be used to enumerate accounts. The hash comparison
    // still runs on a dummy value to keep the timing comparable.
    const hash = user?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv'
    const ok = await verifySecret(password, hash)

    if (!user || !user.isActive || !ok) {
      throw unauthorized('auth:INVALID_CREDENTIALS')
    }

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role })

    return {
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    }
  })
}
