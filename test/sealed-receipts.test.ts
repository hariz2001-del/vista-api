import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '../src/db.ts'
import { env } from '../src/env.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'
const bytes = Buffer.from('verified-scan-fixture')
vi.mock('../src/integrations/drive.ts', async original => ({ ...await original<any>(),
  withinFinances: vi.fn(async (id: string) => ({ id, mimeType: 'image/jpeg', size: String(bytes.length), webViewLink: 'https://drive.google.com/file/d/' + id + '/view' })),
  readFromDrive: vi.fn(async () => bytes),
}))
let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })
it('keeps preview out of Vista, submits atomically once, and serves only the linked scan', async () => {
  const business = await makeBusiness(app), owner = authed(business.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers: owner, payload: { label: 'sealed' } })).json().key
  await app.inject({ method: 'POST', url: '/rms/agent/users', headers: owner, payload: { telegramUserId: '111', role: 'OWNER', name: 'owner' } })
  const headers = { authorization: 'Bearer ' + key, 'x-telegram-user': '111' }
  const brand = await prisma.brand.findFirstOrThrow({ where: { businessId: business.businessId } })
  const payload = { receiptId: randomUUID(), submissionId: randomUUID(), fileId: 'verified-scan-file', sha256: createHash('sha256').update(bytes).digest('hex'), vendor: 'Test merchant', receiptDate: '2026-10-14', receiptNo: 'T1', totalSen: 500, reading: { lines: [{ name: 'Item', amountSen: 500 }] }, entries: [{ businessDate: '2026-10-14', amountSen: 500, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: brand.id, foodSplitPct: 100, description: 'Item', items: [{ name: 'Item', quantityMilli: 1000, unitPriceSen: 500 }] }] }
  const previous = env.DRIVE_BUSINESS_ID; env.DRIVE_BUSINESS_ID = business.businessId
  try {
    const preview = await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers, payload })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(await prisma.receiptDocument.count({ where: { businessId: business.businessId } })).toBe(0)
    expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(0)
    const send = () => app.inject({ method: 'POST', url: '/agent/chopper/submit', headers, payload: { payload, previewToken: preview.json().previewToken } })
    const posted = await send(); expect(posted.statusCode, posted.body).toBe(200)
    expect((await send()).json().alreadySubmitted).toBe(true)
    expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(1)
    expect(await prisma.ledgerEntry.count({ where: { businessId: business.businessId } })).toBe(1)
    expect(await prisma.receiptImage.count({ where: { businessId: business.businessId } })).toBe(0)
    const image = await app.inject({ method: 'GET', url: `/rms/expenses/${posted.json().expenseIds[0]}/receipt`, headers: owner })
    expect(image.statusCode, image.body).toBe(200)
    expect(image.json().imageBase64).toBe(bytes.toString('base64'))
    const otherPhoto = { ...payload, receiptId: randomUUID(), submissionId: randomUUID(), fileId: 'second-photo-file' }
    const secondPreview = await app.inject({ method: 'POST', url: '/agent/chopper/preview', headers, payload: otherPhoto })
    const duplicate = await app.inject({ method: 'POST', url: '/agent/chopper/submit', headers, payload: { payload: otherPhoto, previewToken: secondPreview.json().previewToken } })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.body).toContain('DUPLICATE_INVOICE')
    expect(await prisma.expense.count({ where: { businessId: business.businessId } })).toBe(1)
  } finally { env.DRIVE_BUSINESS_ID = previous }
})
