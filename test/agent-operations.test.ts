import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { prisma } from '../src/db.ts'
import { env } from '../src/env.ts'
import { authed, makeApp, makeBusiness } from './helpers.ts'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })

async function setup() {
  const business = await makeBusiness(app)
  const headers = authed(business.ownerToken)
  const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'Operations' } })).json().key as string
  for (const [id, role] of [['111', 'OWNER'], ['222', 'VIEWER']]) {
    await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId: id, name: role, role } })
  }
  const agent = (user = '111') => ({ authorization: `Bearer ${key}`, 'x-telegram-user': user })
  return { business, headers, agent }
}

it('shares roster rules with RMS, attributes Hermes, and refuses viewers and other businesses', async () => {
  const { business, agent } = await setup()
  const created = await app.inject({ method: 'POST', url: '/agent/team/weeks', headers: agent(), payload: { weekStart: '2026-10-12', fromTemplate: false } })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().week.id
  const detail = await app.inject({ method: 'GET', url: `/agent/team/weeks/${id}`, headers: agent('222') })
  expect(detail.statusCode, detail.body).toBe(200)
  expect(detail.json().week.weekStart).toBe('2026-10-12')
  const denied = await app.inject({ method: 'POST', url: '/agent/team/weeks', headers: agent('222'), payload: { weekStart: '2026-10-19', fromTemplate: false } })
  expect(denied.statusCode).toBe(403)
  const other = await setup()
  expect((await app.inject({ method: 'GET', url: `/agent/team/weeks/${id}`, headers: other.agent() })).statusCode).toBe(404)
  const audit = await prisma.teamAuditEntry.findFirst({ where: { businessId: business.businessId, entityId: id } })
  expect(audit?.actorLabel).toContain('via Hermes')
  expect((await app.inject({ method: 'GET', url: '/agent/team/staff', headers: agent('222') })).statusCode).toBe(403)
})

it('produces PDF and PNG attachments from the live roster and stock data', async () => {
  const { agent } = await setup()
  const created = await app.inject({ method: 'POST', url: '/agent/team/weeks', headers: agent(), payload: { weekStart: '2026-10-12', fromTemplate: false } })
  const id = created.json().week.id
  for (const format of ['pdf', 'png']) {
    const response = await app.inject({ method: 'GET', url: `/agent/reports?kind=roster&id=${id}&format=${format}`, headers: agent() })
    expect(response.statusCode, response.body).toBe(200)
    const bytes = Buffer.from(response.json().contentBase64, 'base64')
    if (format === 'pdf') expect(bytes.subarray(0, 4).toString()).toBe('%PDF')
    else expect((await sharp(bytes).metadata()).format).toBe('png')
  }
  expect((await app.inject({ method: 'GET', url: '/agent/reports?kind=stock-checklist', headers: agent() })).statusCode).toBe(200)
})

it('preserves the original while cropping a receipt, retains edited readings, and serves linked photos privately', async () => {
  const { agent, headers } = await setup()
  const original = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#668844' } }).composite([{ input: Buffer.from('<svg width="200" height="300"><rect width="100%" height="100%" fill="white"/><text x="20" y="100" font-size="24">TEST RECEIPT</text></svg>'), left: 100, top: 100 }]).jpeg().toBuffer()
  const uploaded = await app.inject({ method: 'POST', url: '/agent/receipts', headers: agent(), payload: { imageBase64: original.toString('base64') } })
  const id = uploaded.json().receipt.id
  const scan = await app.inject({ method: 'POST', url: `/agent/receipts/${id}/scan`, headers: agent(), payload: { corners: [{ x: 0.25, y: 0.2 }, { x: 0.75, y: 0.2 }, { x: 0.75, y: 0.8 }, { x: 0.25, y: 0.8 }] } })
  expect(scan.statusCode, scan.body).toBe(200)
  const cached = await prisma.receiptImage.findUniqueOrThrow({ where: { receiptId: id } })
  expect(Buffer.from(cached.bytes)).toEqual(original)
  const meta = await sharp(Buffer.from(cached.scanBytes!)).metadata()
  expect(meta.width).toBeLessThan(220)
  expect(meta.height).toBeLessThan(320)
  const reading = await app.inject({ method: 'PATCH', url: `/agent/receipts/${id}/extraction`, headers: agent(), payload: { vendor: 'Test', receiptDate: '2026-10-12', totalSen: 100, extracted: { lines: [{ name: 'Tea', amount_rm: 1 }], tax_rm: 0 }, reviewFlags: ['The receipt uses a single apostrophe after 8; preserve the printed measurement instead of guessing.'] } })
  expect(reading.statusCode, reading.body).toBe(200)
  await app.inject({ method: 'PATCH', url: `/agent/receipts/${id}/extraction`, headers: agent(), payload: { extracted: { lines: [{ name: 'Edited tea', amount_rm: 1 }] } } })
  const read = (await app.inject({ method: 'GET', url: `/agent/receipts/${id}`, headers: agent() })).json().receipt
  expect(read.extracted).toMatchObject({ lines: [{ name: 'Edited tea' }], tax_rm: 0 })
  const entries = [{ businessDate: '2026-10-12', amountSen: 100, category: 'RAW_MATERIALS', paidBy: 'STALL_FUNDS', brandId: null, foodSplitPct: 100, description: 'Receipt test' }]
  const preview = (await app.inject({ method: 'POST', url: `/agent/receipts/${id}/preview`, headers: agent(), payload: { entries } })).json()
  const post = await app.inject({ method: 'POST', url: `/agent/receipts/${id}/post`, headers: agent(), payload: { entries, previewToken: preview.previewToken } })
  expect(post.statusCode, post.body).toBe(200)
  const expenseId = post.json().expenseIds[0]
  const picture = await app.inject({ method: 'GET', url: `/rms/expenses/${expenseId}/receipt`, headers })
  expect(picture.statusCode, picture.body).toBe(200)
  expect(picture.json().hasScan).toBe(true)
  expect(picture.headers['cache-control']).toBe('private, no-store')
  const other = await setup()
  expect((await app.inject({ method: 'GET', url: `/rms/expenses/${expenseId}/receipt`, headers: other.headers })).statusCode).toBe(404)
})

it('retries a failed Drive upload, stores original and scan before clearing the cache, and confines moves to Finances', async () => {
  const { business, agent } = await setup()
  const previous = { ...env }
  Object.assign(env, { GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', GOOGLE_REFRESH_TOKEN: 'test', DRIVE_FINANCES_FOLDER_ID: 'finances-root', DRIVE_BUSINESS_ID: business.businessId })
  const files = new Map<string, any>([
    ['finances-root', { id: 'finances-root', name: 'Finances', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } }],
    ['outside-file', { id: 'outside-file', name: 'Private elsewhere', mimeType: 'text/plain', parents: ['outside-root'] }],
    ['outside-root', { id: 'outside-root', name: 'Elsewhere', mimeType: 'application/vnd.google-apps.folder' }],
  ])
  let failUpload = true
  let failScan = false
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET'
    const json = (data: object, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'mock-drive-token', expires_in: 3600 })
    const id = url.pathname.split('/files/')[1]
    if (url.pathname.startsWith('/upload/')) {
      if (failUpload) return json({ error: { message: 'Test upload interruption' } }, 503)
      const body = Buffer.from(init.body as Uint8Array)
      const text = body.toString(), start = text.indexOf('\r\n\r\n') + 4
      const metadata = JSON.parse(text.slice(start, text.indexOf('\r\n--', start)))
      if (failScan && metadata.appProperties?.vistaVariant === 'scan') return json({ error: { message: 'Test scan interruption' } }, 503)
      const file = { id: `drive-file-${files.size}`, ...metadata, webViewLink: `https://drive.google.com/file/d/drive-file-${files.size}/view` }
      files.set(file.id, file)
      return json(file)
    }
    if (id && method === 'GET') return json(files.get(id) ?? {}, files.has(id) ? 200 : 404)
    if (method === 'POST') {
      const file = { id: `drive-folder-${files.size}`, ...JSON.parse(init.body as string) }
      files.set(file.id, file)
      return json(file)
    }
    if (method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const parent = q.match(/^'([^']+)' in parents/)?.[1], name = q.match(/name = '([^']+)'/)?.[1]
      return json({ files: [...files.values()].filter((file) => file.parents?.includes(parent) && (!name || file.name === name)) })
    }
    throw new Error(`Unexpected mocked Drive request ${method} ${url.pathname}`)
  }))
  try {
    const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: 'white' } }).jpeg().toBuffer()
    const uploaded = await app.inject({ method: 'POST', url: '/agent/receipts', headers: agent(), payload: { imageBase64: bytes.toString('base64') } })
    expect(uploaded.json().drive).toBe('pending')
    const id = uploaded.json().receipt.id
    const scanned = await app.inject({ method: 'POST', url: `/agent/receipts/${id}/scan`, headers: agent(), payload: {} })
    expect(scanned.json().driveError).toContain('Test upload interruption')
    expect((await prisma.receiptImage.findUniqueOrThrow({ where: { receiptId: id } })).scanBytes).toBeTruthy()
    failUpload = false
    failScan = true
    const interrupted = await app.inject({ method: 'POST', url: '/agent/drive/sync', headers: agent(), payload: { receiptId: id } })
    expect(interrupted.json().results[0].error).toContain('Test scan interruption')
    expect((await prisma.receiptDocument.findUniqueOrThrow({ where: { id } })).driveFileId).toBeTruthy()
    expect((await app.inject({ method: 'GET', url: '/agent/drive/status', headers: agent() })).json().pendingReceipts).toBe(1)
    failScan = false
    const sync = await app.inject({ method: 'POST', url: '/agent/drive/sync', headers: agent(), payload: {} })
    expect(sync.statusCode, sync.body).toBe(200)
    expect(sync.json().results[0].stored).toBe(true)
    const receipt = await prisma.receiptDocument.findUniqueOrThrow({ where: { id } })
    expect(receipt.driveFileId).toBeTruthy()
    expect(receipt.scanDriveFileId).toBeTruthy()
    expect(await prisma.receiptImage.findUnique({ where: { receiptId: id } })).toBeNull()
    const refused = await app.inject({ method: 'PATCH', url: '/agent/drive/files/outside-file', headers: agent(), payload: { name: 'Moved' } })
    expect(refused.statusCode).toBe(502)
    expect(refused.json().message).toContain('outside')
    expect(files.get('outside-file').name).toBe('Private elsewhere')
    expect((await app.inject({ method: 'POST', url: '/agent/drive/folders', headers: agent('222'), payload: { name: 'Not allowed' } })).statusCode).toBe(403)
    const other = await setup()
    expect((await app.inject({ method: 'GET', url: '/agent/drive/status', headers: other.agent() })).statusCode).toBe(403)
  } finally {
    Object.assign(env, previous)
    vi.unstubAllGlobals()
  }
})
