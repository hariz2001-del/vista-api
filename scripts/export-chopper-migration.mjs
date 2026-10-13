import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
const env = parseEnv(await readFile('.env.production', 'utf8'))
const url = env.DIRECT_URL ?? env.DATABASE_URL
if (decodeURIComponent(new URL(url).username) !== 'postgres.xgahhzjzaibykseqmqhz') throw new Error('Current database identity mismatch')
const businessId = 'eb01639f-e95a-4fe2-bfe1-060b8d1119ad'
const db = new PrismaClient({ datasources: { db: { url } }, log: [] })
try {
  const snapshot = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const receipts = await tx.receiptDocument.findMany({ where: { businessId }, include: { expenses: { include: { items: true, payslip: true } }, image: true, job: true, uploadedBy: { select: { telegramUserId: true } } }, orderBy: { createdAt: 'asc' } })
    const expenses = receipts.flatMap(r => r.expenses)
    const ledger = await tx.ledgerEntry.findMany({ where: { businessId, OR: [{ id: { in: [539n, 540n] } }, ...expenses.map(e => ({ businessDate: e.businessDate, description: e.description, amountSen: e.amountSen, brandId: e.brandId }))] }, orderBy: { id: 'asc' } })
    const actions = await tx.agentAction.findMany({ where: { businessId }, orderBy: { id: 'asc' } })
    return { made: new Date().toISOString(), businessId, receipts, ledger, actions, orderCount: await tx.order.count({ where: { businessId } }) }
  }, { timeout: 30000 })
  const folder = resolve('../../backups'); await mkdir(folder, { recursive: true })
  const path = resolve(folder, 'chopper-drive-first-' + Date.now() + '.json')
  await writeFile(path, JSON.stringify(snapshot, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ path, receipts: snapshot.receipts.length, linkedExpenses: snapshot.receipts.flatMap(r => r.expenses).map(e => ({ id: e.id, amountSen: e.amountSen, paidBy: e.paidBy, locked: e.isLocked, payslip: Boolean(e.payslip) })), ledger: snapshot.ledger.map(l => ({ id: String(l.id), direction: l.direction, amountSen: l.amountSen, description: l.description })), orderCount: snapshot.orderCount }))
} finally { await db.$disconnect() }
