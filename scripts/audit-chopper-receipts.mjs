// Read-only inventory for the requested receipt migration/cleanup.
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { PrismaClient } from '@prisma/client'

const env = parseEnv(await readFile('.env.production', 'utf8'))
const url = env.DIRECT_URL ?? env.DATABASE_URL
if (decodeURIComponent(new URL(url).username) !== 'postgres.xgahhzjzaibykseqmqhz') throw new Error('Expected current Vista database; refusing another target')
const businessId = 'eb01639f-e95a-4fe2-bfe1-060b8d1119ad'
const db = new PrismaClient({ datasources: { db: { url } }, log: [] })
try {
  const result = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const receipts = await tx.receiptDocument.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' }, select: {
      id: true, status: true, vendor: true, receiptDate: true, receiptNo: true, totalSen: true,
      driveFileId: true, scanDriveFileId: true, createdAt: true,
      expenses: { select: { id: true, description: true, amountSen: true, businessDate: true, isLocked: true, isSettled: true } },
    } })
    const reversals = await tx.ledgerEntry.findMany({ where: { businessId, OR: [{ description: { contains: 'Corrected' } }, { description: { contains: 'Deleted' } }] }, orderBy: { id: 'asc' }, select: { id: true, businessDate: true, direction: true, category: true, amountSen: true, description: true, orderId: true, correctionId: true } })
    const receiptActions = await tx.agentAction.findMany({ where: { businessId, action: { in: ['receipt.posted', 'expense.edited', 'expense.deleted', 'receipt.maintenance.confirmed'] } }, orderBy: { id: 'asc' }, select: { id: true, action: true, entityId: true, createdAt: true } })
    const correctedExpenseCandidates = await tx.expense.findMany({ where: { businessId, description: { contains: 'FARM FRESH' } }, select: { id: true, description: true, vendor: true, amountSen: true, businessDate: true, receiptDocumentId: true, paidBy: true, isSettled: true, isLocked: true } })
    const correctedLedgerCandidates = await tx.ledgerEntry.findMany({ where: { businessId, description: { contains: 'FARM FRESH' } }, orderBy: { id: 'asc' }, select: { id: true, description: true, direction: true, amountSen: true, businessDate: true, orderId: true, correctionId: true } })
    return { receiptCount: receipts.length, linkedReceiptCount: receipts.filter(r => r.expenses.length).length, receipts, reversals, receiptActions, correctedExpenseCandidates, correctedLedgerCandidates }
  }, { timeout: 30000 })
  console.log(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value))
} finally { await db.$disconnect() }
