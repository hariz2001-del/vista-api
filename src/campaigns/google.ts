import { createHash } from 'node:crypto'

/**
 * Google access for a campaign's order source: either the campaign's own
 * sealed credentials, or Vista's Google connection (the GOOGLE_* settings).
 * Reads the sheet and its proof files; writes only individual cells that Vista
 * owns (see src/campaigns/writeback.ts), never rows, files or formulas.
 */

export type GoogleCredentials = { clientId: string; clientSecret: string; refreshToken: string }

const tokens = new Map<string, { token: string; expires: number }>()

/** Tests swap this out; production uses the platform fetch. */
export let googleFetch: typeof fetch = (input, init) => fetch(input, init)
export function setGoogleFetch(next: typeof fetch | null) {
  googleFetch = next ?? ((input, init) => fetch(input, init))
  tokens.clear()
}

export class GoogleSourceError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function accessToken(credentials: GoogleCredentials): Promise<string> {
  const key = createHash('sha256').update(credentials.clientId + '\n' + credentials.refreshToken).digest('hex')
  const cached = tokens.get(key)
  if (cached && Date.now() < cached.expires - 60_000) return cached.token
  const response = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
  if (!response.ok || !body.access_token) throw new GoogleSourceError(`token refresh failed: ${body.error ?? response.status}`, response.status)
  tokens.set(key, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}

async function get(credentials: GoogleCredentials, url: string): Promise<Response> {
  const response = await googleFetch(url, { headers: { Authorization: `Bearer ${await accessToken(credentials)}` } })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new GoogleSourceError(`Google ${response.status}: ${text.slice(0, 200)}`, response.status)
  }
  return response
}

/**
 * Every row of one tab, formulas kept, so a HYPERLINK cell still carries its
 * link (the proof file) and not only its label.
 */
export async function readSheetTab(credentials: GoogleCredentials, sheetId: string, tab: string): Promise<unknown[][]> {
  const range = encodeURIComponent(`${tab}!A1:ZZ`)
  const response = await get(
    credentials,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${range}?valueRenderOption=FORMULA&dateTimeRenderOption=FORMATTED_STRING`,
  )
  const body = (await response.json()) as { values?: unknown[][] }
  return body.values ?? []
}

/** Set individual cells, e.g. `Preorders!L5` → "Paid". Values are entered as if typed. */
export async function writeSheetCells(
  credentials: GoogleCredentials,
  sheetId: string,
  cells: Array<{ range: string; value: string | boolean }>,
): Promise<void> {
  if (cells.length === 0) return
  const response = await googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(credentials)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: cells.map((cell) => ({ range: cell.range, values: [[cell.value]] })),
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new GoogleSourceError(`Google ${response.status}: ${text.slice(0, 200)}`, response.status)
  }
}

/** A1 column letters for a 0-based column index (0 → A, 27 → AB). */
export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    out = String.fromCharCode(65 + rest) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** A Drive file's bytes and type, for showing a payment proof to the owner. */
export async function readDriveFile(credentials: GoogleCredentials, fileId: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await get(credentials, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes, mimeType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' }
}

/** The file id in a Drive link (…/file/d/<id>/…, ?id=<id>), or null. */
export function driveFileId(url: string | null | undefined): string | null {
  if (!url) return null
  const path = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url)
  if (path) return path[1]!
  const query = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url)
  return query ? query[1]! : null
}
