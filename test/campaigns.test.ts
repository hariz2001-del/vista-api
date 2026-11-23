import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { authed, login, loginOwner, makeApp, makeBusiness, productByName, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let owner: string
let counter: string
beforeAll(async () => {
  process.env.CAMPAIGN_SECRET_KEY = 'test-campaign-secret-key-that-is-long-enough-123'
  app = await makeApp()
  owner = await loginOwner(app)
  counter = await login(app)
})
beforeEach(resetTransactional)
afterAll(async () => {
  // Leave no extra till sessions behind for later files (rms-state counts them).
  await app.inject({ method: 'POST', url: '/rms/counter/sign-out', headers: authed(owner) })
  await app.close()
  await prisma.$disconnect()
})

const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, token = owner) =>
  app.inject({ method, url, headers: authed(token), ...(payload === undefined ? {} : { payload: payload as object }) })

async function createCampaign(name = 'Sarang in Bloom') {
  const response = await call('POST', '/rms/campaigns', { name, status: 'ACTIVE', tileTone: 'LIGHT' })
  expect(response.statusCode).toBe(201)
  return response.json().campaign.id as string
}

async function pngBase64(colour: string, width = 2400, height = 900) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer()
  return bytes.toString('base64')
}

describe('campaigns', () => {
  it('lets the owner create and list campaigns, and refuses the counter', async () => {
    const id = await createCampaign()
    const list = await call('GET', '/rms/campaigns')
    expect(list.statusCode).toBe(200)
    const [tile] = list.json().campaigns
    expect(tile).toMatchObject({ id, name: 'Sarang in Bloom', status: 'ACTIVE', background: null, logo: null })
    expect(tile.counts).toEqual({ orders: 0, UNVERIFIED: 0, VERIFIED: 0, REJECTED: 0 })

    expect((await call('GET', '/rms/campaigns', undefined, counter)).statusCode).toBe(403)
    expect((await call('POST', '/rms/campaigns', { name: 'Nope' }, counter)).statusCode).toBe(403)
  })

  it('keeps each business to its own campaigns', async () => {
    const id = await createCampaign()
    const other = await makeBusiness(app)
    const list = await call('GET', '/rms/campaigns', undefined, other.ownerToken)
    expect(list.json().campaigns).toEqual([])
    expect((await call('GET', `/rms/campaigns/${id}`, undefined, other.ownerToken)).statusCode).toBe(404)
    expect((await call('PATCH', `/rms/campaigns/${id}`, { name: 'Taken' }, other.ownerToken)).statusCode).toBe(404)
  })

  it('stores products and coupon benefits as configuration, independently per campaign', async () => {
    const latte = await productByName('Nasi Lemak Ayam')
    const bloom = await createCampaign()
    const set = await call('PUT', `/rms/campaigns/${bloom}/catalogue`, {
      products: [
        { name: 'Crimson Charm', externalKey: 'Crimson Charm', priceSen: 2400 },
        { name: 'Golden Scholar', externalKey: 'Golden Scholar', priceSen: 2400 },
      ],
      benefits: [
        { kind: 'PREPAID_PRODUCT', label: 'Flower bouquet', valueSen: 1900 },
        { kind: 'FIXED_VOUCHER', label: 'Drink voucher', valueSen: 500, categoryIds: [latte.categoryId] },
      ],
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().products.map((product: { name: string }) => product.name)).toEqual(['Crimson Charm', 'Golden Scholar'])
    expect(set.json().benefits).toHaveLength(2)

    // A second campaign with different benefits: same code, no effect on the first.
    const second = await createCampaign('Raya Hampers')
    const other = await call('PUT', `/rms/campaigns/${second}/catalogue`, {
      products: [{ name: 'Hamper', externalKey: 'Hamper', priceSen: 9900 }],
      benefits: [{ productIndex: 0, kind: 'FIXED_VOUCHER', label: 'RM10 off', valueSen: 1000 }],
    })
    expect(other.statusCode).toBe(200)
    expect(other.json().benefits[0]).toMatchObject({ kind: 'FIXED_VOUCHER', valueSen: 1000, campaignProductId: other.json().products[0].id })

    const first = (await call('GET', `/rms/campaigns/${bloom}`)).json()
    expect(first.benefits.map((benefit: { label: string; valueSen: number }) => [benefit.label, benefit.valueSen])).toEqual([
      ['Flower bouquet', 1900],
      ['Drink voucher', 500],
    ])
  })

  it('refuses a benefit pointing at another business menu', async () => {
    const id = await createCampaign()
    const other = await makeBusiness(app)
    const brand = await prisma.brand.create({ data: { businessId: other.businessId, name: 'Theirs', colour: '#000000', softColour: '#eeeeee' } })
    const theirs = await prisma.category.create({ data: { businessId: other.businessId, brandId: brand.id, name: 'Their drinks' } })
    const response = await call('PUT', `/rms/campaigns/${id}/catalogue`, {
      products: [],
      benefits: [{ kind: 'FIXED_VOUCHER', label: 'x', valueSen: 500, categoryIds: [theirs.id] }],
    })
    expect(response.statusCode).toBe(400)
  })

  it('uploads, replaces and removes the tile background', async () => {
    const id = await createCampaign()
    const first = await call('PUT', `/rms/campaigns/${id}/images/background`, { imageBase64: await pngBase64('#c2185b'), mimeType: 'image/png' })
    expect(first.statusCode).toBe(200)
    const background = first.json().campaign.background
    expect(background.width).toBe(1600) // resized on the way in
    const image = await call('GET', `/rms/campaigns/${id}/images/background`)
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/webp')
    expect(image.headers['cache-control']).toContain('private')

    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await call('PUT', `/rms/campaigns/${id}/images/background`, { imageBase64: await pngBase64('#1b5e20', 800, 400), mimeType: 'image/png' })
    expect(second.json().campaign.background.version).toBeGreaterThan(background.version)
    expect(second.json().campaign.background.width).toBe(800)

    const list = (await call('GET', '/rms/campaigns')).json()
    expect(list.campaigns[0].background.version).toBe(second.json().campaign.background.version)

    const removed = await call('DELETE', `/rms/campaigns/${id}/images/background`)
    expect(removed.json().campaign.background).toBeNull()
    expect((await call('GET', `/rms/campaigns/${id}/images/background`)).statusCode).toBe(404)
  })

  it('refuses something that is not an image', async () => {
    const id = await createCampaign()
    const response = await call('PUT', `/rms/campaigns/${id}/images/logo`, {
      imageBase64: Buffer.from('not an image at all').toString('base64'),
      mimeType: 'image/png',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('campaign:IMAGE_INVALID')
  })

  it('freezes an archived campaign until it is restored', async () => {
    const id = await createCampaign()
    const archived = await call('PATCH', `/rms/campaigns/${id}`, { status: 'ARCHIVED' })
    expect(archived.json().campaign.archivedAt).not.toBeNull()
    expect((await call('PATCH', `/rms/campaigns/${id}`, { name: 'Changed' })).statusCode).toBe(409)
    expect((await call('PUT', `/rms/campaigns/${id}/catalogue`, { products: [], benefits: [] })).statusCode).toBe(409)

    const restored = await call('PATCH', `/rms/campaigns/${id}`, { status: 'INACTIVE' })
    expect(restored.statusCode).toBe(200)
    expect(restored.json().campaign).toMatchObject({ status: 'INACTIVE', archivedAt: null })
  })

  it('seals source credentials and never returns or audits them', async () => {
    const id = await createCampaign()
    const response = await call('PUT', `/rms/campaigns/${id}/source`, {
      kind: 'GOOGLE_SHEET',
      config: { sheetId: 'sheet-id-1234567890', tab: 'Preorders' },
      secret: { refreshToken: 'super-secret-refresh-token' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().source).toEqual({
      kind: 'GOOGLE_SHEET',
      config: { sheetId: 'sheet-id-1234567890', tab: 'Preorders' },
      hasSecret: true,
    })
    expect(response.body).not.toContain('super-secret')

    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id } })
    expect(stored.sourceSecret).toMatch(/^v1\./)
    expect(stored.sourceSecret).not.toContain('super-secret')

    // Leaving the secret out keeps it.
    const kept = await call('PUT', `/rms/campaigns/${id}/source`, { kind: 'GOOGLE_SHEET', config: { sheetId: 'sheet-id-1234567890', tab: 'Orders' } })
    expect(kept.json().source.hasSecret).toBe(true)

    const audit = await call('GET', `/rms/campaigns/${id}/audit`)
    expect(audit.body).not.toContain('super-secret')
    expect(audit.json().entries.map((entry: { action: string }) => entry.action)).toContain('campaign.source')
  })

  it('keeps an append-only audit trail', async () => {
    const id = await createCampaign()
    await call('PATCH', `/rms/campaigns/${id}`, { name: 'Renamed' })
    const audit = (await call('GET', `/rms/campaigns/${id}/audit`)).json()
    expect(audit.entries.map((entry: { action: string }) => entry.action)).toEqual(['campaign.edit', 'campaign.create'])
    await expect(prisma.campaignAuditEntry.deleteMany({ where: { campaignId: id } })).rejects.toThrow()
    await expect(prisma.campaignAuditEntry.updateMany({ where: { campaignId: id }, data: { action: 'tampered' } })).rejects.toThrow()
  })
})
