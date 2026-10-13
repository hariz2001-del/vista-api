// Owner-authorised exact cleanup. Requires the exported backup and migrated
// Drive register; never uses the expense-delete route (which adds reversals).
import { readFile, writeFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { PrismaClient } from '@prisma/client'
const backupPath = process.argv[2]
if (!backupPath || !process.argv.includes('--apply')) throw new Error('Explicit backup and --apply required')
const backup = JSON.parse(await readFile(backupPath, 'utf8'))
const env = parseEnv(await readFile('.env.production', 'utf8')), url = env.DIRECT_URL ?? env.DATABASE_URL
if (decodeURIComponent(new URL(url).username) !== 'postgres.xgahhzjzaibykseqmqhz' || backup.businessId !== 'eb01639f-e95a-4fe2-bfe1-060b8d1119ad') throw new Error('Identity mismatch')
const businessId = backup.businessId, db = new PrismaClient({ datasources: { db: { url } }, log: [] })
const expenseId = '15c8a26c-ada5-4b6f-b66a-737e063933e2'
try {
  const result = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':chopper-cleanup'}))::text`
    const receipts = await tx.receiptDocument.findMany({ where: { businessId, id: { in: backup.receipts.map(r => r.id) } }, include: { expenses: { include: { payslip: true } } } })
    if (receipts.length !== 32 || backup.receipts.length !== 32 || receipts.some(r => backup.receipts.find(s => s.id === r.id)?.sha256 !== r.sha256)) throw new Error('Receipt inventory changed; re-export first')
    const expenses = receipts.flatMap(r => r.expenses)
    if (expenses.length !== 1 || expenses[0].id !== expenseId || expenses[0].amountSen !== 1795 || expenses[0].paidBy !== 'STALL_FUNDS' || expenses[0].isLocked || expenses[0].payslip) throw new Error('Expense allowlist changed')
    const ids = [539n, 540n, 771n]
    const ledger = await tx.ledgerEntry.findMany({ where: { businessId, id: { in: ids } }, orderBy: { id: 'asc' } })
    if (ledger.length !== 3 || ledger.some(r => r.orderId || r.correctionId || !backup.ledger.some(s => s.id === String(r.id) && s.amountSen === r.amountSen && s.direction === r.direction && s.description === r.description))) throw new Error('Ledger allowlist changed')
    if (ledger[0].amountSen !== 8195 || ledger[1].amountSen !== 8195 || ledger[0].direction !== 'MONEY_OUT' || ledger[1].direction !== 'MONEY_IN' || ledger[2].amountSen !== 1795 || ledger[2].description !== expenses[0].description) throw new Error('Pair/expense correspondence changed')
    const ordersBefore = await tx.order.count({ where: { businessId } })
    await tx.expense.delete({ where: { id: expenseId, businessId } })
    await tx.ledgerEntry.deleteMany({ where: { businessId, id: { in: ids } } })
    await tx.receiptDocument.deleteMany({ where: { businessId, id: { in: receipts.map(r => r.id) } } })
    if (await tx.order.count({ where: { businessId } }) !== ordersBefore) throw new Error('POS inventory changed')
    const actor = await tx.agentUser.findUniqueOrThrow({ where: { businessId_telegramUserId: { businessId, telegramUserId: 304348232n } } })
    await tx.agentAction.create({ data: { businessId, agentUserId: actor.id, action: 'chopper.migration.cleanup', entityType: 'migration', entityId: 'drive-first-20261014', detail: { ownerAuthorised: true, expenseIds: [expenseId], ledgerIds: ids.map(String), receiptIds: receipts.map(r => r.id), backup: backupPath.split(/[\\/]/).at(-1), bankIncreaseSen: 1795, preserveOtherExpensesAndPOS: true } } })
    return { removedExpenses: 1, removedLedgerRows: 3, migratedReceiptMetadataRemoved: 32, bankIncreaseSen: 1795, ordersPreserved: ordersBefore, backupPath }
  }, { timeout: 30000 })
  await writeFile(backupPath + '.cleanup-result.json', JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(result))
} finally { await db.$disconnect() }
