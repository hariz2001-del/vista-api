import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * Set one business account's password and counter PIN, and optionally its email.
 *
 *   npx tsx scripts/set-credentials.ts <email> <password> <4-digit-pin> [new-email]
 *
 * `<email>` is the account's current email, which is how the business is found.
 * This is also the only password recovery there is: sign-up does not verify
 * email addresses, so a reset link sent to one could not be trusted.
 *
 * Every device signed in to that business is signed out, because its session
 * was issued under the old password. Other businesses are not touched.
 */

async function main(): Promise<void> {
  const [email, password, pin, newEmail] = process.argv.slice(2)

  if (!email || !email.includes('@')) throw new Error('First argument must be the account email.')
  if (!password || password.length < 12) throw new Error('Password must be at least 12 characters.')
  if (!pin || !/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits.')
  if (newEmail !== undefined && !newEmail.includes('@')) {
    throw new Error('The new email must be an email address.')
  }

  const prisma = new PrismaClient()
  try {
    const account = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    if (!account) throw new Error(`No account with the email ${email}.`)

    const [passwordHash, pinHash] = await Promise.all([
      bcrypt.hash(password, 10),
      bcrypt.hash(pin, 10),
    ])
    const finalEmail = (newEmail ?? email).toLowerCase()

    await prisma.$transaction([
      prisma.user.update({
        where: { id: account.id },
        data: { email: finalEmail, passwordHash, pinHash },
      }),
      prisma.session.updateMany({
        where: { businessId: account.businessId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])

    console.log(`Updated ${finalEmail}. Every device of that business has been signed out.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
