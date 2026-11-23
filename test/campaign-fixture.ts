import type { FastifyInstance } from 'fastify'
import { setGoogleFetch } from '../src/campaigns/google.ts'
import { authed } from './helpers.ts'

/**
 * A stand-in for Google: a token endpoint, one sheet tab, and Drive files.
 * The rows mimic the real Sarang in Bloom sheet (HYPERLINK cells, one row per
 * set, the order total repeated on each row) without being tied to it.
 */
export type FakeGoogle = {
  rows: unknown[][]
  files: Map<string, { bytes: Buffer; mimeType: string }>
  calls: string[]
  failSheet: boolean
  failWrites: boolean
  /** Every cell written, in order. */
  writes: Array<{ range: string; value: unknown }>
}

export const HEADERS = [
  'Order code', 'Submitted (MYT)', 'Name', 'WhatsApp', 'Set', 'Chalk message', 'Item',
  'Pickup date', 'Pickup slot', 'Order total (RM)', 'Receipt', 'Status', 'Notes',
  'Coupon', 'Coupon status', 'Voucher redeemed', 'Message style', 'Design preview',
]

export function sheetRow(input: {
  code: string
  submitted?: string
  name?: string
  set?: string
  item?: string
  total?: number
  fileId?: string
  status?: string
  coupon?: string
  message?: string
  style?: string
  /** A design-preview cell as the order form writes it. */
  design?: string
  /** The WhatsApp cell's text; defaults to 012-345 6789. */
  phone?: string
  pickupDate?: string
  pickupSlot?: string
}) {
  return [
    input.code,
    input.submitted ?? '16/11/2026 21:40',
    input.name ?? 'Aina',
    input.phone ?? '=HYPERLINK("https://wa.me/60123456789","012-345 6789")',
    input.set ?? 'Crimson Charm (Rose set)',
    input.message ?? 'Happy grad!',
    input.item ?? '1 of 1',
    input.pickupDate ?? 'Fri 20 Nov',
    input.pickupSlot ?? 'Night Owls, 9PM to 12AM',
    input.total ?? 24,
    input.fileId ? `=HYPERLINK("https://drive.google.com/file/d/${input.fileId}/view?usp=drivesdk","View receipt")` : '',
    input.status ?? 'Pending check',
    '',
    input.coupon ?? '',
    '=IF(INDIRECT("L"&ROW())="Rejected","Void","Not valid yet")',
    false,
    input.style ?? 'Classic',
    input.design ?? 'No preview',
  ]
}

export function fakeGoogle(): FakeGoogle {
  const state: FakeGoogle = { rows: [HEADERS], files: new Map(), calls: [], failSheet: false, failWrites: false, writes: [] }
  setGoogleFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    state.calls.push(`${method} ${url}`)
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'fake-access', expires_in: 3600 })
    }
    if (method === 'POST' && url.includes('values:batchUpdate')) {
      if (state.failWrites) return new Response('quota', { status: 429 })
      const body = JSON.parse(String(init?.body)) as { data: Array<{ range: string; values: unknown[][] }> }
      for (const item of body.data) {
        state.writes.push({ range: item.range, value: item.values[0]![0] })
        const cell = /!([A-Z]+)(\d+)$/.exec(item.range)!
        const col = cell[1]!.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
        const row = state.rows[Number(cell[2]) - 1]!
        row[col] = item.values[0]![0]
      }
      return Response.json({})
    }
    if (method !== 'GET') return new Response('unexpected write', { status: 405 })
    if (url.includes('sheets.googleapis.com')) {
      if (state.failSheet) return new Response('backend error', { status: 503 })
      return Response.json({ values: state.rows })
    }
    const file = /drive\/v3\/files\/([^?]+)\?alt=media/.exec(url)
    if (file) {
      const found = state.files.get(decodeURIComponent(file[1]!))
      return found ? new Response(new Uint8Array(found.bytes), { headers: { 'content-type': found.mimeType } }) : new Response('nope', { status: 404 })
    }
    return new Response('unknown', { status: 404 })
  }) as typeof fetch)
  return state
}

export const WRITE_BACK = { enabled: true, verified: 'Paid', rejected: 'Rejected', unverified: 'Pending check', keepWhenVerified: ['Ready', 'Collected'] }

export const SHEET_COLUMNS = {
  orderRef: 'Order code',
  customerName: 'Name',
  submittedAt: 'Submitted (MYT)',
  contact: 'WhatsApp',
  product: 'Set',
  total: 'Order total (RM)',
  proof: 'Receipt',
  status: 'Status',
  coupon: 'Coupon',
  redeemed: 'Voucher redeemed',
}

/** A bloom-like campaign with a sheet source and its catalogue. */
export async function sheetCampaign(
  app: FastifyInstance,
  ownerToken: string,
  extras: { drinkCategoryId?: string; flowerProductId?: string; writeBack?: boolean } = {},
) {
  const call = (method: 'POST' | 'PUT', url: string, payload: object) => app.inject({ method, url, headers: authed(ownerToken), payload })
  const created = await call('POST', '/rms/campaigns', { name: 'Bloom', status: 'ACTIVE' })
  if (created.statusCode !== 201) throw new Error(created.body)
  const id = created.json().campaign.id as string
  const catalogue = await call('PUT', `/rms/campaigns/${id}/catalogue`, {
    products: [
      { name: 'Crimson Charm', externalKey: 'Crimson Charm', priceSen: 2400 },
      { name: 'Golden Scholar', externalKey: 'Golden Scholar', priceSen: 2400 },
    ],
    benefits: [
      { kind: 'PREPAID_PRODUCT', label: 'Flower bouquet', valueSen: 1900, productId: extras.flowerProductId ?? null },
      { kind: 'FIXED_VOUCHER', label: 'Drink voucher', valueSen: 500, categoryIds: extras.drinkCategoryId ? [extras.drinkCategoryId] : [] },
    ],
  })
  if (catalogue.statusCode !== 200) throw new Error(catalogue.body)
  const source = await call('PUT', `/rms/campaigns/${id}/source`, {
    kind: 'GOOGLE_SHEET',
    config: {
      sheetId: 'fake-sheet-0123456789',
      tab: 'Preorders',
      columns: SHEET_COLUMNS,
      totalPer: 'ORDER',
      fulfilmentColumns: ['Pickup date', 'Pickup slot'],
      ...(extras.writeBack ? { writeBack: WRITE_BACK } : {}),
    },
    secret: { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' },
  })
  if (source.statusCode !== 200) throw new Error(source.body)
  return id
}
