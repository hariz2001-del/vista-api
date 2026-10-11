import type { Tx } from '../db.ts'
import { env } from '../env.ts'

/**
 * Receipt photos in the owner's Google Drive, under their Finances folder:
 *
 *   Finances/Receipts/Unsorted/     until the date on the receipt is known
 *   Finances/Receipts/2026/10 October/Week of 6 Oct/   by the receipt's own date after that
 *
 * The file id is stored on the receipt; the database never depends on file
 * names. A personal Google account cannot take uploads from a service account
 * (they have no storage), so this signs in as the owner with a refresh token
 * made once by `scripts/google-drive-token.mjs`.
 */

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'

export function driveConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN && env.DRIVE_FINANCES_FOLDER_ID)
}

let cached: { token: string; until: number } | null = null

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) throw new Error(`google token: ${response.status}`)
  const body = (await response.json()) as { access_token: string; expires_in: number }
  cached = { token: body.access_token, until: Date.now() + body.expires_in * 1000 }
  return cached.token
}

async function drive<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...init.headers },
  })
  if (!response.ok) throw new Error(`drive ${init.method ?? 'GET'} ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return (await response.json()) as T
}

const folders = new Map<string, string>()

/** A folder by name inside a parent, made if missing. */
async function folder(parent: string, name: string): Promise<string> {
  const cacheKey = `${parent}/${name}`
  const known = folders.get(cacheKey)
  if (known) return known
  const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = `'${parent}' in parents and name = '${safe}' and mimeType = '${FOLDER}' and trashed = false`
  const found = await drive<{ files: Array<{ id: string }> }>(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`)
  const id =
    found.files[0]?.id ??
    (
      await drive<{ id: string }>(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      })
    ).id
  folders.set(cacheKey, id)
  return id
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT = MONTHS.map((month) => month.slice(0, 3))

/** "Week of 6 Oct": the Monday of the receipt's Monday–Sunday week. */
export function weekFolderName(date: Date): string {
  const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000)
  return `Week of ${monday.getUTCDate()} ${SHORT[monday.getUTCMonth()]}`
}

/** Receipts/2026/10 October/Week of 6 Oct — or Receipts/Unsorted until the date is known. */
async function folderFor(date: Date | null): Promise<string> {
  const receipts = await folder(env.DRIVE_FINANCES_FOLDER_ID!, 'Receipts')
  if (!date) return folder(receipts, 'Unsorted')
  const year = await folder(receipts, String(date.getUTCFullYear()))
  const month = await folder(year, `${String(date.getUTCMonth() + 1).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`)
  return folder(month, weekFolderName(date))
}

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
}

/**
 * Put a receipt's photo in Drive (once) and drop the database copy. Returns
 * false when Drive is not set up, leaving the photo safely where it is.
 */
export async function storeReceiptImage(db: Tx, receiptId: string): Promise<boolean> {
  if (!driveConfigured()) return false
  const receipt = await db.receiptDocument.findUnique({ where: { id: receiptId }, include: { image: true } })
  if (!receipt) return false
  if (receipt.driveFileId || !receipt.image) return Boolean(receipt.driveFileId)
  const parent = await folderFor(receipt.receiptDate)
  const name = `R-${receipt.id.slice(0, 6).toUpperCase()}${receipt.vendor ? ` ${receipt.vendor}` : ''}.${EXTENSION[receipt.mimeType] ?? 'jpg'}`
  const boundary = `vista-${receipt.id}`
  const metadata = JSON.stringify({ name, parents: [parent], appProperties: { vistaReceiptId: receipt.id } })
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${receipt.mimeType}\r\n\r\n`),
    Buffer.from(receipt.image.bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const file = await drive<{ id: string; webViewLink: string }>(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  await db.receiptDocument.update({ where: { id: receiptId }, data: { driveFileId: file.id, driveUrl: file.webViewLink } })
  await db.receiptImage.deleteMany({ where: { receiptId } })
  return true
}

/** Once the receipt's date is known, file the photo under its year and month. */
export async function fileByDate(db: Tx, receiptId: string): Promise<void> {
  if (!driveConfigured()) return
  const receipt = await db.receiptDocument.findUnique({ where: { id: receiptId } })
  if (!receipt?.driveFileId || !receipt.receiptDate) return
  const target = await folderFor(receipt.receiptDate)
  const current = await drive<{ parents?: string[] }>(`${API}/files/${receipt.driveFileId}?fields=parents`)
  if (current.parents?.includes(target)) return
  await drive(`${API}/files/${receipt.driveFileId}?addParents=${target}&removeParents=${(current.parents ?? []).join(',')}&fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}

/** The photo's bytes, from Drive. */
export async function readFromDrive(fileId: string): Promise<Buffer> {
  const response = await fetch(`${API}/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` } })
  if (!response.ok) throw new Error(`drive read ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}
