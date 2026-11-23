import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lineArtwork } from '../src/campaigns/artwork.ts'
import { setGoogleFetch } from '../src/campaigns/google.ts'
import { prisma } from '../src/db.ts'
import { fakeGoogle, sheetCampaign, sheetRow, SHEET_COLUMNS, type FakeGoogle } from './campaign-fixture.ts'
import { authed, login, loginOwner, makeApp, resetTransactional } from './helpers.ts'

let app: FastifyInstance
let owner: string
let google: FakeGoogle
let campaignId: string

const ART_COLUMNS = { ...SHEET_COLUMNS, message: 'Chalk message', messageStyle: 'Message style', design: 'Design preview' }
const STYLES = { Classic: { font: 'Caveat', weight: 600 }, Cursive: { font: 'Dancing Script', weight: 600 } }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

beforeAll(async () => {
  process.env.CAMPAIGN_SECRET_KEY = 'test-campaign-secret-key-that-is-long-enough-123'
  app = await makeApp()
  owner = await loginOwner(app)
})
beforeEach(async () => {
  await resetTransactional()
  google = fakeGoogle()
  campaignId = await sheetCampaign(app, owner)
  const detail = (await app.inject({ method: 'GET', url: `/rms/campaigns/${campaignId}`, headers: authed(owner) })).json()
  const saved = await app.inject({
    method: 'PUT',
    url: `/rms/campaigns/${campaignId}/source`,
    headers: authed(owner),
    payload: { kind: 'GOOGLE_SHEET', config: { ...detail.source.config, columns: ART_COLUMNS, messageStyles: STYLES } },
  })
  expect(saved.statusCode, saved.body).toBe(200)
  google.files.set('designFile0001', { bytes: JPEG, mimeType: 'image/jpeg' })
  google.files.set('notAPicture01', { bytes: Buffer.from('<html>'), mimeType: 'text/html' })
  google.rows.push(
    sheetRow({ code: 'BLOOM-ART1', coupon: 'SIB-ART1-0001', item: '1 of 2', message: 'Tahniah Adik!', style: 'Cursive', design: '=HYPERLINK("https://drive.google.com/file/d/designFile0001/view","View design")' }),
    sheetRow({ code: 'BLOOM-ART1', coupon: 'SIB-ART1-0002', item: '2 of 2', message: 'Proud of you', style: 'Classic' }),
    sheetRow({ code: 'BLOOM-HTML', design: '=HYPERLINK("https://drive.google.com/file/d/notAPicture01/view","View design")' }),
  )
  const synced = await app.inject({ method: 'POST', url: `/rms/campaigns/${campaignId}/sync`, headers: authed(owner) })
  expect(synced.statusCode, synced.body).toBe(200)
})
afterAll(async () => {
  await app.inject({ method: 'POST', url: '/rms/counter/sign-out', headers: authed(owner) })
  setGoogleFetch(null)
  await app.close()
  await prisma.$disconnect()
})

const get = (url: string, token = owner) => app.inject({ method: 'GET', url, headers: authed(token) })
const orderOf = async (ref: string) => prisma.campaignOrder.findFirstOrThrow({ where: { externalRef: ref }, include: { lines: { orderBy: { lineNo: 'asc' } } } })

describe('reading what the customer made', () => {
  it('finds the message, style and design link from the column settings', () => {
    const details = { 'Chalk message': 'Hi', 'Message style': 'Playful', 'Design preview': 'View design <https://drive.google.com/file/d/abcdefghij12/view>' }
    expect(lineArtwork(details, ART_COLUMNS)).toEqual({ message: 'Hi', messageStyle: 'Playful', designFileId: 'abcdefghij12' })
    expect(lineArtwork({ 'Design preview': 'No preview' }, ART_COLUMNS).designFileId).toBeNull()
    expect(lineArtwork(details, SHEET_COLUMNS)).toEqual({ message: null, messageStyle: null, designFileId: null })
  })
})

describe('order detail', () => {
  it('shows each set with its message, style, design and coupon, plus what the coupons give', async () => {
    const order = await orderOf('BLOOM-ART1')
    const response = await get(`/rms/campaigns/${campaignId}/orders/${order.id}`)
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.order.lines).toMatchObject([
      { message: 'Tahniah Adik!', messageStyle: 'Cursive', hasDesign: true },
      { message: 'Proud of you', messageStyle: 'Classic', hasDesign: false },
    ])
    expect(body.order.coupons).toMatchObject([
      { code: 'SIB-ART1-0001', lineId: order.lines[0]!.id, redeemedAt: null },
      { code: 'SIB-ART1-0002', lineId: order.lines[1]!.id, redeemedAt: null },
    ])
    expect(body.messageStyles).toEqual(STYLES)
    expect(body.benefits.map((benefit: { label: string; valueSen: number }) => [benefit.label, benefit.valueSen])).toEqual([
      ['Flower bouquet', 1900],
      ['Drink voucher', 500],
    ])
  })

  it('serves the design preview to the owner only, and only if it is a picture', async () => {
    const art = await orderOf('BLOOM-ART1')
    const url = `/rms/campaigns/${campaignId}/orders/${art.id}/lines/${art.lines[0]!.id}/design`
    const image = await get(url)
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/jpeg')
    expect(image.headers['cache-control']).toBe('private, no-store')
    expect(image.rawPayload.equals(JPEG)).toBe(true)

    expect((await get(`/rms/campaigns/${campaignId}/orders/${art.id}/lines/${art.lines[1]!.id}/design`)).statusCode).toBe(404)
    const html = await orderOf('BLOOM-HTML')
    expect((await get(`/rms/campaigns/${campaignId}/orders/${html.id}/lines/${html.lines[0]!.id}/design`)).statusCode).toBe(400)
    // A line of another order cannot be reached through this one.
    expect((await get(`/rms/campaigns/${campaignId}/orders/${html.id}/lines/${art.lines[0]!.id}/design`)).statusCode).toBe(404)
    expect((await get(url, await login(app))).statusCode).toBe(403)
  })

  it('keeps the lettering styles when the source is saved again, and refuses a font name that is not one', async () => {
    const detail = (await get(`/rms/campaigns/${campaignId}`)).json()
    expect(detail.source.config.messageStyles).toEqual(STYLES)
    const bad = await app.inject({
      method: 'PUT',
      url: `/rms/campaigns/${campaignId}/source`,
      headers: authed(owner),
      payload: { kind: 'GOOGLE_SHEET', config: { ...detail.source.config, messageStyles: { Classic: { font: "Caveat'); @import url(x" } } } },
    })
    expect(bad.statusCode).toBe(400)
  })
})
