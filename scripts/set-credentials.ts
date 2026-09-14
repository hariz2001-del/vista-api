import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * Set the business account's email, password and counter PIN.
 *
 *   npx tsx scripts/set-credentials.ts <email> <password> <4-digit-pin>
 *
 * Run on a server straight after seeding, so the demo password written in the
 * README never works on a public machine. Every signed-in device is signed out,
 * because its session was issued under the old password.
 */

async function main(): Promise<void> {
  const [email, password, pin] = process.argv.slice(2)

  if (!email || !email.includes('@')) throw new Error('First argument must be an email address.')
  if (!password || password.length < 12) throw new Error('Password must be at least 12 characters.')
  if (!pin || !/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits.')

  const prisma = new PrismaClient()
  try {
    // The business has one account.
    const account = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
    if (!account) throw new Error('No account exists yet. Run the seed first.')

    const [passwordHash, pinHash] = await Promise.all([
      bcrypt.hash(password, 10),
      bcrypt.hash(pin, 10),
    ])

    await prisma.$transaction([
      prisma.user.update({
        where: { id: account.id },
        data: { email: email.toLowerCase(), passwordHash, pinHash },
      }),
      prisma.session.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])

    console.log(`Updated ${email.toLowerCase()}. Every device has been signed out.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
