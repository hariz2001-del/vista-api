import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { PrismaClient } from '@prisma/client'
const env = parseEnv(await readFile('.env.source-pre-migration.production', 'utf8'))
if (decodeURIComponent(new URL(env.DIRECT_URL).username) !== 'postgres.kjjbijhszwpiyicoftls') throw new Error('Source guard')
const db = new PrismaClient({ datasources: { db: { url: env.DIRECT_URL } }, log: [] })
const releaseFile = '.env.migration-release-20261013'
if (existsSync(releaseFile)) throw new Error('Release signal already exists')
try {
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='15s'")
    const tables = await tx.$queryRawUnsafe("SELECT quote_ident(schemaname)||'.'||quote_ident(tablename) AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    if (tables.length !== 57) throw new Error('Unexpected source table count')
    await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map(t => t.name).join(',')} IN SHARE MODE`)
    console.log('SOURCE WRITES FROZEN. Reads/backups allowed. Create release signal to unlock; automatic release after 20 minutes.')
    await new Promise(resolve => {
      const timer = setTimeout(finish, 20 * 60_000)
      const poll = setInterval(() => { if (existsSync(releaseFile)) finish() }, 1000)
      function finish() { clearTimeout(timer); clearInterval(poll); resolve() }
    })
  }, { timeout: 21 * 60_000, maxWait: 20000 })
} finally { await db.$disconnect() }
console.log('SOURCE LOCK RELEASED')
