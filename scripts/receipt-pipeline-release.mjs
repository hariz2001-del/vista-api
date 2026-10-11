import { spawn } from 'node:child_process'

process.loadEnvFile('.env.production')
const target = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL)
if (!target.hostname.endsWith('.supabase.com') || target.pathname !== '/postgres') throw new Error('Refusing an unexpected database target.')
const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient()
try {
  const accounts = await db.accountSettings.findMany({ select: { businessId: true, businessName: true } })
  console.log(JSON.stringify({ databaseHost: target.hostname, accounts }))
  const receiptId = process.argv.find((arg) => arg.startsWith('--receipt='))?.slice('--receipt='.length)
  if (receiptId) {
    const receipt = await db.receiptDocument.findUniqueOrThrow({ where: { id: receiptId }, select: { id: true, businessId: true, status: true, driveFileId: true, scanDriveFileId: true, image: { select: { receiptId: true } } } })
    console.log(JSON.stringify({ receipt, temporaryImageCachePresent: Boolean(receipt.image) }))
  }
  if (process.argv.includes('--migrate')) {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npx prisma migrate deploy'], { stdio: 'inherit', env: process.env })
    const code = await new Promise((resolve) => child.on('close', resolve))
    if (code) process.exitCode = code
  }
} finally { await db.$disconnect() }
