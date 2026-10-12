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
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(`Google sign-in failed (${response.status}, ${error.error ?? 'unknown'}). Check the OAuth client and refresh token in Vercel.`)
  }
  const body = (await response.json()) as { access_token: string; expires_in: number }
  cached = { token: body.access_token, until: Date.now() + body.expires_in * 1000 }
  return cached.token
}

async function drive<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...init.headers },
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(`Drive ${init.method ?? 'GET'} failed (${response.status}): ${error.error?.message ?? 'request refused'}`)
  }
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
  if (!env.DRIVE_BUSINESS_ID || receipt.businessId !== env.DRIVE_BUSINESS_ID) return false
  if (receipt.driveFileId) {
    if (receipt.image?.scanBytes) await storeReceiptScan(db, receiptId)
    else if (receipt.image) await db.receiptImage.deleteMany({ where: { receiptId } })
    return true
  }
  if (!receipt.image) return false
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
  if (receipt.image.scanBytes) await storeReceiptScan(db, receiptId)
  else await db.receiptImage.deleteMany({ where: { receiptId } })
  return true
}

/** Once the receipt's date is known, file the photo under its year and month. */
export async function fileByDate(db: Tx, receiptId: string): Promise<void> {
  if (!driveConfigured()) return
  const receipt = await db.receiptDocument.findUnique({ where: { id: receiptId } })
  if (!receipt?.driveFileId || !receipt.receiptDate) return
  if (!env.DRIVE_BUSINESS_ID || receipt.businessId !== env.DRIVE_BUSINESS_ID) return
  const current = await drive<{ parents?: string[]; appProperties?: Record<string, string> }>(`${API}/files/${receipt.driveFileId}?fields=parents,appProperties`)
  // An owner-directed organisation stays put when automatic filing retries.
  if (current.appProperties?.vistaFolderMode === 'manual') return
  const target = await folderFor(receipt.receiptDate)
  if (current.parents?.includes(target)) return
  await drive(`${API}/files/${receipt.driveFileId}?addParents=${target}&removeParents=${(current.parents ?? []).join(',')}&fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (receipt.scanDriveFileId) await editDriveFile(receipt.scanDriveFileId, { parentId: target })
}

/** The photo's bytes, from Drive. */
export async function readFromDrive(fileId: string): Promise<Buffer> {
  const response = await fetch(`${API}/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` } })
  if (!response.ok) throw new Error(`drive read ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; webViewLink?: string; size?: string; capabilities?: { canAddChildren?: boolean; canEdit?: boolean }; appProperties?: Record<string, string>; trashed?: boolean }
const FIELDS = 'id,name,mimeType,parents,webViewLink,size,capabilities(canAddChildren,canEdit),appProperties,trashed'

export async function driveFile(id: string): Promise<DriveFile> {
  return drive(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`)
}

/** No arbitrary Google Drive access: both source and destination must descend from Finances. */
export async function withinFinances(id: string): Promise<DriveFile> {
  if (!driveConfigured()) throw new Error('Google Drive is not configured on this deployment.')
  const original = await driveFile(id)
  const pending = [original]
  const seen = new Set<string>()
  while (pending.length && seen.size < 100) {
    const file = pending.shift()!
    if (file.trashed) continue
    if (file.id === env.DRIVE_FINANCES_FOLDER_ID) return original
    if (seen.has(file.id)) continue
    seen.add(file.id)
    for (const parent of file.parents ?? []) pending.push(await driveFile(parent))
  }
  throw new Error('This file or folder is outside the configured Finances folder.')
}

export async function listDrive(parent = env.DRIVE_FINANCES_FOLDER_ID!, pageToken?: string) {
  const file = await withinFinances(parent)
  if (file.mimeType !== FOLDER) throw new Error('The parent must be a folder.')
  const q = `'${file.id}' in parents and trashed = false`
  return drive<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${FIELDS})&pageSize=100&orderBy=folder,name${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)
}

export async function createDriveFolder(parent: string, name: string) {
  const file = await withinFinances(parent)
  if (file.mimeType !== FOLDER) throw new Error('The parent must be a folder.')
  return driveFile(await folder(parent, name))
}

export async function editDriveFile(id: string, changes: { name?: string; parentId?: string; description?: string }) {
  const file = await withinFinances(id)
  if (id === env.DRIVE_FINANCES_FOLDER_ID) throw new Error('The Finances root cannot be moved or renamed.')
  if (changes.parentId) {
    const parent = await withinFinances(changes.parentId)
    if (parent.mimeType !== FOLDER) throw new Error('The destination must be a folder.')
    if (file.mimeType === FOLDER) {
      const queue = [parent]
      const seen = new Set<string>()
      while (queue.length && seen.size < 100) {
        const item = queue.shift()!
        if (item.id === id) throw new Error('A folder cannot move inside itself.')
        if (seen.has(item.id)) continue
        seen.add(item.id)
        for (const ancestor of item.parents ?? []) queue.push(await driveFile(ancestor))
      }
    }
  }
  const query = changes.parentId ? `&addParents=${encodeURIComponent(changes.parentId)}&removeParents=${(file.parents ?? []).map(encodeURIComponent).join(',')}` : ''
  const result = await drive<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}${query}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(changes.name ? { name: changes.name } : {}), ...(changes.description !== undefined ? { description: changes.description } : {}), ...(changes.parentId && file.appProperties?.vistaReceiptId ? { appProperties: { ...file.appProperties, vistaFolderMode: 'manual' } } : {}) }),
  })
  folders.clear()
  return result
}

export async function writeDriveFile(input: { parentId?: string; fileId?: string; name: string; mimeType: string; bytes: Buffer; appProperties?: Record<string, string> }) {
  if (input.fileId) {
    const existing = await withinFinances(input.fileId)
    if (existing.appProperties?.vistaReceiptId && !['scan', 'allocation'].includes(existing.appProperties.vistaVariant ?? '')) throw new Error('Receipt originals are preserved. Create a separate file or update an existing derived scan/annotation instead.')
    if (existing.mimeType.startsWith('application/vnd.google-apps.')) throw new Error('Use a regular file for content replacement; native Google documents are not supported here.')
    await drive(`${UPLOAD}/files/${encodeURIComponent(input.fileId)}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': input.mimeType }, body: input.bytes })
    return editDriveFile(input.fileId, { name: input.name })
  }
  const parent = await withinFinances(input.parentId ?? env.DRIVE_FINANCES_FOLDER_ID!)
  if (parent.mimeType !== FOLDER) throw new Error('The destination must be a folder.')
  const boundary = `vista-${crypto.randomUUID()}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ name: input.name, parents: [parent.id], appProperties: input.appProperties })}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
    input.bytes, Buffer.from(`\r\n--${boundary}--`),
  ])
  return drive<DriveFile>(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
}

/** Recovery after an upload succeeded but its response/DB write was lost. */
export async function findReceiptAnnotation(parent: string, receiptId: string): Promise<DriveFile | undefined> {
  await withinFinances(parent)
  const q = `'${parent}' in parents and trashed = false and appProperties has { key='vistaReceiptId' and value='${receiptId}' } and appProperties has { key='vistaVariant' and value='allocation' }`
  const result = await drive<{ files: DriveFile[] }>(`${API}/files?${new URLSearchParams({ q, fields: `files(${FIELDS})`, pageSize: '10' })}`)
  return result.files[0]
}

export async function storeReceiptScan(db: Tx, receiptId: string): Promise<boolean> {
  if (!driveConfigured()) return false
  const receipt = await db.receiptDocument.findUnique({ where: { id: receiptId }, include: { image: true } })
  if (!receipt?.driveFileId || !receipt.image?.scanBytes || !env.DRIVE_BUSINESS_ID || receipt.businessId !== env.DRIVE_BUSINESS_ID) return false
  const original = await driveFile(receipt.driveFileId)
  const name = `R-${receipt.id.slice(0, 6).toUpperCase()}${receipt.vendor ? ` ${receipt.vendor}` : ''} - scan.jpg`
  const file = await writeDriveFile({ fileId: receipt.scanDriveFileId ?? undefined, parentId: original.parents?.[0], name, mimeType: 'image/jpeg', bytes: Buffer.from(receipt.image.scanBytes), appProperties: { vistaReceiptId: receipt.id, vistaVariant: 'scan' } })
  await db.receiptDocument.update({ where: { id: receiptId }, data: { scanDriveFileId: file.id, scanDriveUrl: file.webViewLink } })
  await db.receiptImage.deleteMany({ where: { receiptId } })
  return true
}
