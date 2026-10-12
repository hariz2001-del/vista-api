import type { FastifyInstance } from 'fastify'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { makeApp, makeBusiness, authed } from './helpers.ts'
import { prisma } from '../src/db.ts'
import { env } from '../src/env.ts'
let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })
async function setup() {
  const b = await makeBusiness(app), headers = authed(b.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'direct-drive' } })).json().key
  for (const [telegramUserId, role] of [['111', 'OWNER'], ['222', 'BOOKKEEPER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId, role, name: role } })
  const call = (method: any, url: string, payload?: any, user = '111') => app.inject({ method, url, payload, headers: { authorization: `Bearer ${key}`, 'x-telegram-user': user } })
  const uploaded = (await call('POST', '/agent/receipts', { imageBase64: Buffer.from('original:' + b.businessId).toString('base64'), deferProcessing: true })).json().receipt
  await prisma.receiptDocument.update({ where: { id: uploaded.id }, data: { driveFileId: 'source-image', scanDriveFileId: 'old-scan-file', extracted: { lines: [{ name: 'Keep reading', qty: 1, unit_price_sen: 1000, amount_sen: 1000 }], scan: { corners: [1], sha256: 'old' } } } })
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: b.businessId } })
  const expenseResponse = await app.inject({ method: 'POST', url: '/rms/expenses', headers, payload: { businessDate: '2026-10-10', amountSen: 1000, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: brand.id, foodSplitPct: 100, description: 'Keep accounting' } })
  expect(expenseResponse.statusCode, expenseResponse.body).toBe(200)
  const expense = expenseResponse.json()
  await prisma.expense.update({ where: { id: expense.id }, data: { receiptDocumentId: uploaded.id } })
  return { b, call, receipt: uploaded, expense }
}
async function mocked(s: Awaited<ReturnType<typeof setup>>, fn: (state: { trashed: boolean }) => Promise<void>) {
  const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'DRIVE_FINANCES_FOLDER_ID', 'DRIVE_BUSINESS_ID'] as const
  const before = Object.fromEntries(keys.map(k => [k, env[k]]))
  Object.assign(env, { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test', DRIVE_FINANCES_FOLDER_ID: 'root-finances', DRIVE_BUSINESS_ID: s.b.businessId })
  const state = { trashed: false }
  vi.stubGlobal('fetch', async (url: string, init: any = {}) => {
    expect(init.method ?? 'GET').not.toBe('PATCH') // Synchronization cannot mutate Google files.
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'test', expires_in: 3600 }))
    if (url.includes('alt=media')) return new Response('replacement-bytes')
    const id = url.split('/files/')[1]?.split('?')[0]
    return new Response(JSON.stringify(id === 'root-finances' ? { id, mimeType: 'application/vnd.google-apps.folder', parents: [] } : {
      id, name: 'Receipt.jpg', mimeType: 'image/jpeg', parents: id === 'outside-file' ? [] : ['root-finances'], trashed: id === 'source-image' && state.trashed,
      appProperties: id === 'backup-image' ? { chopperBackupFor: 'source-image', chopperOperationId: 'a'.repeat(32) } : { vistaReceiptId: s.receipt.id },
    }))
  })
  try { await fn(state) } finally { Object.assign(env, before); vi.unstubAllGlobals() }
}
it('syncs direct replacement idempotently, preserves booked links/reading/ledger and invalidates old image cache', async () => {
  const s = await setup()
  await mocked(s, async () => {
    const event = { operationId: 'a'.repeat(32), fileId: 'source-image', operation: 'replace', backupFileId: 'backup-image', sha256: createHash('sha256').update('replacement-bytes').digest('hex') }
    const result = await s.call('POST', '/agent/drive/changes', event)
    expect(result.statusCode, result.body).toBe(200)
    const receipt = await prisma.receiptDocument.findUniqueOrThrow({ where: { id: s.receipt.id } })
    expect(receipt.driveFileId).toBe('source-image'); expect(receipt.scanDriveFileId).toBeNull()
    expect((receipt.extracted as any).lines[0].name).toBe('Keep reading')
    expect((receipt.extracted as any).scan).toBeUndefined()
    expect(await prisma.receiptImage.findUnique({ where: { receiptId: receipt.id } })).toBeNull()
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: s.expense.id } })).receiptDocumentId).toBe(receipt.id)
    expect((await s.call('POST', '/agent/drive/changes', event)).json().alreadySynced).toBe(true)
    expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(1)
    expect(await prisma.agentAction.count({ where: { businessId: s.b.businessId, action: 'chopper.drive.synced' } })).toBe(1)
  })
})
it('owner can trash and restore booked evidence without deleting accounting; trashed bytes cannot be served', async () => {
  const s = await setup()
  await prisma.receiptDocument.update({ where: { id: s.receipt.id }, data: { scanDriveFileId: null } })
  await mocked(s, async state => {
    state.trashed = true
    const event = { operationId: 'b'.repeat(32), fileId: 'source-image', operation: 'trash' }
    expect((await s.call('POST', '/agent/drive/changes', event)).statusCode).toBe(200)
    expect((await s.call('GET', `/agent/receipts/${s.receipt.id}/image`)).statusCode).not.toBe(200)
    state.trashed = false
    expect((await s.call('POST', '/agent/drive/changes', { ...event, operationId: 'c'.repeat(32), operation: 'restore' })).statusCode).toBe(200)
    const image = await s.call('GET', `/agent/receipts/${s.receipt.id}/image`)
    expect(image.statusCode, image.body).toBe(200)
    expect(Buffer.from(image.json().imageBase64, 'base64').toString()).toBe('replacement-bytes')
    expect(await prisma.expense.count({ where: { businessId: s.b.businessId } })).toBe(1)
  })
})
it('rejects partner, out-of-scope, root, unverified backups, mismatched bytes and bad state', async () => {
  const s = await setup()
  await mocked(s, async () => {
    const event = { operationId: 'a'.repeat(32), fileId: 'source-image', operation: 'replace', backupFileId: 'backup-image', sha256: '0'.repeat(64) }
    expect((await s.call('POST', '/agent/drive/changes', event, '222')).statusCode).toBe(403)
    expect((await s.call('POST', '/agent/drive/changes', { ...event, fileId: 'outside-file' })).statusCode).not.toBe(200)
    expect((await s.call('POST', '/agent/drive/changes', { ...event, fileId: 'root-finances' })).statusCode).toBe(403)
    expect((await s.call('POST', '/agent/drive/changes', { ...event, backupFileId: 'source-image' })).statusCode).toBe(409)
    expect((await s.call('POST', '/agent/drive/changes', event)).statusCode).toBe(409)
    expect((await s.call('POST', '/agent/drive/changes', { ...event, operation: 'trash' })).statusCode).toBe(409)
  })
})
it('resolves receipt references in the authenticated business and rejects ambiguous references', async () => {
  const s = await setup()
  const ref = `R-${s.receipt.id.slice(0, 6).toUpperCase()}`
  expect((await s.call('GET', `/agent/receipts/resolve?ref=${ref}`)).json().id).toBe(s.receipt.id)
  await prisma.receiptDocument.create({ data: { id: s.receipt.id.slice(0, 6) + '00-0000-4000-8000-000000000000', businessId: s.b.businessId, sha256: 'second', mimeType: 'image/jpeg' } })
  expect((await s.call('GET', `/agent/receipts/resolve?ref=${ref}`)).statusCode).toBe(409)
})
