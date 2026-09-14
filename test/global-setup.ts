import { execSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'

/**
 * Runs once before the suite, in the main process, against the test database
 * chosen in `vitest.config.ts`: creates it if missing, brings it to the latest
 * migration, and reseeds the catalogue the tests assert real prices against.
 *
 * Refuses outright unless the target's name ends in `_test`, so a mistake in the
 * config can never point `prisma migrate` and the seed at real data.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL
  const adminUrl = process.env.VISTA_ADMIN_DATABASE_URL
  if (!url || !adminUrl) throw new Error('vitest.config.ts did not set the test database URLs')

  const name = new URL(url).pathname.slice(1)
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing to prepare "${name}": a test database name must end in _test.`)
  }

  const admin = new PrismaClient({ datasourceUrl: adminUrl })
  try {
    const found = await admin.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}
    `
    // The name was validated above; CREATE DATABASE cannot take a parameter.
    if (!found[0]?.n) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.$disconnect()
  }

  // Fixed command strings, no interpolated input — so running them through a
  // shell (which npx.cmd on Windows needs) is safe.
  const run = (command: string) => execSync(command, { stdio: 'inherit', env: process.env })

  run('npx prisma migrate deploy')
  run('npx tsx prisma/seed.ts')
}
