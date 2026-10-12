import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FastifyRequest } from 'fastify'
import { env } from '../env.ts'
import type { LineWorkflow } from '../receipt-form.ts'
import { driveConfigured, driveFile, findReceiptAnnotation, readFromDrive, writeDriveFile } from './drive.ts'

const escape = (value: string) => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
const json = (v: unknown) => JSON.parse(JSON.stringify(v))
export async function renderReceiptAnnotation(scan: Buffer, lines: Array<{ name: string }>, ledger: LineWorkflow, brands: Array<{ id: string; name: string; colour: string }>) {
  const image = await sharp(scan).rotate().resize({ width: 1000, withoutEnlargement: true }).png().toBuffer()
  const meta = await sharp(image).metadata(), width = meta.width!, height = meta.height!, margin = 500
  const outputHeight = Math.max(height, 100 + lines.length * 60), regions = ledger.regions ?? []
  const colour = (brand: string | null | undefined) => /^#[0-9a-f]{6}$/i.test(brands.find(b => b.id === brand)?.colour ?? '') ? brands.find(b => b.id === brand)!.colour : '#2563eb'
  const brandName = (brand: string | null | undefined) => brand === 'SHARED' ? 'Shared' : brands.find(b => b.id === brand)?.name ?? 'Unknown brand'
  let positioned = 0
  const shapes: string[] = [], legend: string[] = []
  for (const [i, line] of lines.entries()) {
    const decision = ledger.decisions[i] ?? { state: 'pending' }, region = regions.find(r => r.index === i)
    const text = decision.state === 'posted' ? brandName(decision.brand) : decision.state === 'scrapped' ? 'SCRAPPED — excluded, no expense' : 'Pending'
    const tint = decision.state === 'scrapped' ? '#b91c1c' : decision.state === 'pending' ? '#64748b' : colour(decision.brand)
    legend.push(`<text x="${width + 20}" y="${75 + i * 60}" font-size="18" fill="${tint}">${i + 1}. ${escape(line.name.slice(0, 38))}</text><text x="${width + 20}" y="${98 + i * 60}" font-size="16" fill="${tint}">${escape(text)}</text>`)
    if (decision.state === 'pending' || !region) continue
    const x = region.x * width, y = region.y * height, w = region.width * width, h = region.height * height
    shapes.push(decision.state === 'scrapped' ? `<path d="M${x},${y + h / 2} h${w}" stroke="${tint}" stroke-width="3"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${tint}" fill-opacity="0.2" stroke="${tint}" stroke-width="2"/>`)
    shapes.push(`<text x="${Math.max(2, x - 24)}" y="${y + Math.min(h, 20)}" font-size="18" fill="${tint}">${i + 1}</text>`); positioned++
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width + margin}" height="${outputHeight}" font-family="sans-serif"><text x="${width + 20}" y="30" font-size="20">Allocation copy — original preserved</text><text x="${width + 20}" y="52" font-size="14">Printed total unchanged. Pending items are not booked.</text>${shapes.join('')}${legend.join('')}</svg>`)
  const bytes = await sharp({ create: { width: width + margin, height: outputHeight, channels: 4, background: '#ffffff' } }).composite([{ input: image, left: 0, top: 0 }, { input: svg, left: 0, top: 0 }]).png().toBuffer()
  return { bytes, positioned }
}

/** Safe derived copy. Upload retries never repeat a financial transaction. */
export async function annotateReceipt(db: FastifyRequest['db'], id: string, businessId: string) {
  if (!driveConfigured()) return { pending: true, reason: 'Drive not configured' }
  const token = randomUUID()
  let busy = false
  const receipt = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${businessId} FOR UPDATE`
    const r = await tx.receiptDocument.findUnique({ where: { id }, include: { image: true } })
    const ledger = (r?.extracted as any)?._lineWorkflow as LineWorkflow | undefined
    if (!r || !ledger || !ledger.decisions.some(d => d.state !== 'pending')) return null
    if (env.DRIVE_BUSINESS_ID && r.businessId !== env.DRIVE_BUSINESS_ID) return null
    if (ledger.annotation?.version === ledger.version) return null
    if (ledger.annotationLease && ledger.annotationLease.until > Date.now()) { busy = true; return null }
    ledger.annotationLease = { token, until: Date.now() + 120_000 }
    await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...(r.extracted as any), _lineWorkflow: ledger }) } })
    return { ...r, ledger }
  })
  if (!receipt) return { pending: busy, unchanged: !busy }
  try {
    if (!receipt.scanDriveFileId && !receipt.image?.scanBytes) throw new Error('scan missing')
    const scan = receipt.image?.scanBytes ? Buffer.from(receipt.image.scanBytes) : await readFromDrive(receipt.scanDriveFileId!)
    const parent = (await driveFile(receipt.scanDriveFileId ?? receipt.driveFileId!)).parents?.[0]
    if (!parent) throw new Error('scan folder missing')
    const brands = await db.brand.findMany({ select: { id: true, name: true, colour: true } })
    const lines = [...((receipt.extracted as any)?.lines ?? [])]
    while (lines.length < receipt.ledger.decisions.length) lines.push({ name: 'Tax / discount / rounding difference' })
    const rendered = await renderReceiptAnnotation(scan, lines, receipt.ledger, brands)
    const existing = receipt.ledger.annotation?.id ?? (await findReceiptAnnotation(parent, id))?.id
    const file = await writeDriveFile({ fileId: existing, parentId: parent, name: `R-${id.slice(0, 6).toUpperCase()}-allocations.png`, mimeType: 'image/png', bytes: rendered.bytes, appProperties: { vistaReceiptId: id, vistaVariant: 'allocation' } })
    const url = file.webViewLink
    if (!url) throw new Error('Drive annotation URL missing')
    let current = false
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${businessId} FOR UPDATE`
      const r = await tx.receiptDocument.findUniqueOrThrow({ where: { id } }), ledger = (r.extracted as any)._lineWorkflow as LineWorkflow
      if (ledger.annotationLease?.token !== token) return
      current = ledger.version === receipt.ledger.version && isDeepStrictEqual(ledger.regions, receipt.ledger.regions)
      ledger.annotation = { id: file.id, url, version: current ? ledger.version : -1, positioned: rendered.positioned }; delete ledger.annotationLease; delete ledger.annotationError
      await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...(r.extracted as any), _lineWorkflow: ledger }) } })
    })
    const printedCount = ((receipt.extracted as any)?.lines ?? []).length
    return { pending: !current, url, positioned: rendered.positioned, needsRegions: receipt.ledger.decisions.some((d, i) => i < printedCount && d.state !== 'pending' && !receipt.ledger.regions?.some(r => r.index === i)) }
  } catch {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id = ${id} AND business_id = ${businessId} FOR UPDATE`
      const r = await tx.receiptDocument.findUniqueOrThrow({ where: { id } }), ledger = (r.extracted as any)._lineWorkflow as LineWorkflow
      if (ledger.annotationLease?.token === token) { delete ledger.annotationLease; ledger.annotationError = 'Annotation pending; retry separately from accounting.'; await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...(r.extracted as any), _lineWorkflow: ledger }) } }) }
    })
    return { pending: true, reason: 'Annotated Drive copy pending; original and saved entries are safe.' }
  }
}
