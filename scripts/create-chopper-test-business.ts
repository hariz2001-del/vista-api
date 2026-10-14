/**
 * A test business for Chopper, so its tests never create live expenses: the live
 * business's brands, settings and partners copied, the same Telegram users with
 * the same roles, an owner login for RMS, and one agent key for Vista's own tests.
 * Safe to run twice. Secrets go to a local file outside the repo, never stdout.
 *
 *   DATABASE_URL=<DIRECT_URL> npx tsx scripts/create-chopper-test-business.ts <live business id = DRIVE_BUSINESS_ID>
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { hashAgentKey, newAgentKey } from '../src/auth.ts'

const NAME = 'Sarang Test (Chopper)'
const EMAIL = 'chopper-test@vistahub.my'
const TELEGRAM = [304348232n, 942922800n]
const SECRETS = join(homedir(), '.vista-secrets', 'chopper-test-business.json')
const prisma = new PrismaClient()

const omit = <T extends Record<string, unknown>>(row: T, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))

async function main() {
  const live = process.argv[2] ?? ''
  if (!/^[0-9a-f-]{36}$/.test(live)) throw new Error('Pass the live business id (DRIVE_BUSINESS_ID).')
  const liveUsers = await prisma.agentUser.findMany({ where: { businessId: live, telegramUserId: { in: TELEGRAM } } })
  if (liveUsers.length !== TELEGRAM.length) throw new Error(`Live business has ${liveUsers.length} of the ${TELEGRAM.length} Telegram users`)

  const saved = existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : {}
  const result = await prisma.$transaction(async tx => {
    let business = await tx.business.findFirst({ where: { name: NAME } })
    if (!business) {
      business = await tx.business.create({ data: { name: NAME } })
      const brandMap = new Map<string, string>()
      for (const brand of await tx.brand.findMany({ where: { businessId: live }, orderBy: { sortOrder: 'asc' } })) {
        brandMap.set(brand.id, (await tx.brand.create({ data: { ...omit(brand, 'id', 'businessId', 'createdAt'), businessId: business.id } as any })).id)
      }
      const settings = await tx.accountSettings.findUnique({ where: { businessId: live } })
      if (settings) await tx.accountSettings.create({ data: { ...omit(settings, 'businessId', 'updatedAt'), businessId: business.id, businessName: NAME, outletName: `${settings.outletName} (test)` } as any })
      for (const partner of await tx.partner.findMany({ where: { businessId: live } })) {
        await tx.partner.create({ data: { ...omit(partner, 'id', 'businessId'), businessId: business.id, brandId: brandMap.get(partner.brandId)! } as any })
      }
    }
    // Owner login for RMS. A new password only when none is on file.
    let password = saved.rmsPassword as string | undefined
    const owner = await tx.user.findUnique({ where: { email: EMAIL } })
    if (!owner || !password) {
      password = randomBytes(9).toString('base64url')
      const passwordHash = await bcrypt.hash(password, 10)
      if (owner) await tx.user.update({ where: { email: EMAIL }, data: { passwordHash } })
      else await tx.user.create({ data: { businessId: business.id, email: EMAIL, passwordHash, name: 'Test owner', role: 'OWNER' } })
    }
    for (const user of liveUsers) {
      await tx.agentUser.upsert({
        where: { businessId_telegramUserId: { businessId: business.id, telegramUserId: user.telegramUserId } },
        create: { businessId: business.id, telegramUserId: user.telegramUserId, name: user.name, role: user.role },
        update: { role: user.role, isActive: true },
      })
    }
    let vistaTestKey = saved.vistaTestKey as string | undefined
    if (!vistaTestKey || !(await tx.agentKey.findUnique({ where: { keyHash: hashAgentKey(vistaTestKey) } }))) {
      vistaTestKey = newAgentKey()
      await tx.agentKey.create({ data: { businessId: business.id, label: 'Vista API tests', keyHash: hashAgentKey(vistaTestKey) } })
    }
    return { businessId: business.id, liveBusinessId: live, rmsEmail: EMAIL, rmsPassword: password, vistaTestKey, roles: liveUsers.map(u => ({ telegramUserId: String(u.telegramUserId), role: u.role })) }
  })
  mkdirSync(join(homedir(), '.vista-secrets'), { recursive: true })
  writeFileSync(SECRETS, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ businessId: result.businessId, roles: result.roles, secretsFile: SECRETS }))
}

main().finally(() => prisma.$disconnect())
