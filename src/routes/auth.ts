import { createHash, randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { attemptLimitConfig, clientKey, type AttemptOptions } from '../attempts.ts'
import { hashSecret, requireHub, signSession, verifySecret, type SessionScope } from '../auth.ts'
import { prisma } from '../db.ts'
import { conflict, unauthorized } from '../errors.ts'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /**
   * Which app is signing in. Each business has one account; this decides what
   * the session can reach. Defaults to the narrowest that sells.
   */
  scope: z.enum(['COUNTER', 'OWNER', 'HUB']).default('COUNTER'),
})

const registerBody = z.object({
  businessName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(200),
  pin: z.string().regex(/^\d{4}$/),
})

const handoffBody = z.object({ target: z.enum(['POS', 'RMS']) })
const redeemBody = z.object({ code: z.string().min(20).max(100) })

/** A handoff code is swapped for a session within seconds; a minute is generous. */
const HANDOFF_TTL_MS = 60_000

/** The app each handoff target opens, and the session it gets there. */
const TARGET_SCOPE = { POS: 'COUNTER', RMS: 'OWNER' } as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export type AuthOptions = AttemptOptions & {
  /** New businesses per hour, per client. Production uses the default. */
  registrationLimit: number
}

export async function authRoutes(app: FastifyInstance, options: AuthOptions): Promise<void> {
  /** One session row per sign-in, so the owner can revoke any device from the RMS. */
  async function openSession(
    user: { id: string; email: string; role: string; businessId: string },
    scope: SessionScope,
  ) {
    const session = await prisma.session.create({
      data: { businessId: user.businessId, userId: user.id, scope },
    })
    const payload = { id: user.id, email: user.email, role: user.role, sid: session.id, scope }
    return signSession((body, signOptions) => app.jwt.sign(body, signOptions), payload)
  }

  // At most 10 sign-in attempts per 15 minutes per client. Each business has
  // one account, so this password is the whole business.
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

    // A counter session never expires: the cashier only has the PIN, and the
    // tablet must not sign itself out mid-service. An owner session lasts a day,
    // a hub session half an hour.
    const token = await openSession(user, scope)

    return {
      token,
      scope,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    }
  })

  /**
   * Register a new business, from vistahub.my.
   *
   * Open to anyone, with no email check — the owner chose that. What it creates
   * is empty and harmless: an account, a one-brand menu with nothing on it yet,
   * and settings with partner settlement off. The account gets a hub session,
   * which can only choose an app.
   *
   * Limited per client address, so one script cannot fill the database. Unlike
   * sign-in, it has to say when an email is taken — the person registering
   * needs to know to sign in instead — so that much is discoverable, at five
   * tries an hour.
   */
  app.post(
    '/auth/register',
    {
      config: {
        rateLimit: {
          max: options.registrationLimit,
          timeWindow: '1 hour',
          keyGenerator: (request: FastifyRequest) => clientKey(request),
        },
      },
    },
    async (request) => {
      const body = registerBody.parse(request.body)

      const [passwordHash, pinHash] = await Promise.all([
        hashSecret(body.password),
        hashSecret(body.pin),
      ])

      let user
      try {
        user = await prisma.$transaction(async (tx) => {
          const business = await tx.business.create({ data: { name: body.businessName } })
          const businessId = business.id

          const owner = await tx.user.create({
            data: {
              businessId,
              email: body.email,
              name: body.businessName,
              role: 'OWNER',
              passwordHash,
              pinHash,
            },
          })

          await tx.accountSettings.create({
            data: {
              businessId,
              businessName: body.businessName,
              outletName: body.businessName,
              settlementEnabled: false,
              // Read only by partner settlement, which starts switched off.
              sharedOverheadFoodPct: 70,
              hostCommissionPct: 30,
              capitalAssetFoodPct: 50,
            },
          })

          // Every product needs a brand and a category, so a new business starts
          // with one of each, ready for its first item.
          const brand = await tx.brand.create({
            data: {
              businessId,
              name: body.businessName,
              colour: '#ef6c35',
              softColour: '#fff0e8',
              sortOrder: 1,
            },
          })
          await tx.category.create({
            data: { businessId, brandId: brand.id, name: 'Menu', sortOrder: 1 },
          })

          return owner
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw conflict('auth:EMAIL_TAKEN')
        }
        throw error
      }

      const token = await openSession(user, 'HUB')
      return {
        token,
        scope: 'HUB',
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      }
    },
  )

  /**
   * Mint a one-time code to open the POS or RMS already signed in.
   *
   * Each app keeps its own sign-in on its own domain, so the hub cannot hand a
   * token across. It hands this instead: random, stored only as a hash, good for
   * one minute and one use. It travels in the URL fragment, which browsers never
   * send to a server, so it does not end up in anyone's access log.
   */
  app.post('/auth/handoff', { preHandler: requireHub }, async (request) => {
    const { target } = handoffBody.parse(request.body)
    const code = randomBytes(32).toString('base64url')

    // Clear codes long past their minute on the way past.
    await prisma.handoffCode.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } },
    })
    await prisma.handoffCode.create({
      data: {
        businessId: request.businessId,
        userId: request.user.id,
        codeHash: sha256(code),
        target: TARGET_SCOPE[target],
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
      },
    })

    return { code, target }
  })

  /**
   * Swap a handoff code for the app's own session. The code is spent by a
   * guarded update, so two tabs racing with the same code get one session
   * between them, not two.
   */
  app.post('/auth/handoff/redeem', { config: attemptLimitConfig(options) }, async (request) => {
    const { code } = redeemBody.parse(request.body)
    const codeHash = sha256(code)
    const now = new Date()

    const spent = await prisma.handoffCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    })
    if (spent.count === 0) throw unauthorized('auth:HANDOFF_INVALID')

    const handoff = await prisma.handoffCode.findUnique({
      where: { codeHash },
      include: { user: true },
    })
    if (!handoff || !handoff.user.isActive) throw unauthorized('auth:HANDOFF_INVALID')

    const { user } = handoff
    const token = await openSession(user, handoff.target)
    return {
      token,
      scope: handoff.target,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    }
  })
}
