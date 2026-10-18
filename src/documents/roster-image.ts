import sharp from 'sharp'
import { baseline, measure, textPath, wrap, type TextStyle } from './text.ts'

/**
 * The roster as it is shared in WhatsApp: days, times and names, and when it
 * was last changed. Made here so the RMS button and Sarang AI hand out the
 * same picture. Drawn from the export alone, which carries nothing else.
 */

export type RosterExport = {
  businessName: string
  weekStart: string
  label: string
  isPublished: boolean
  updatedAt: string
  days: Array<{ date: string; label: string; shifts: Array<{ startTime: string; endTime: string; label: string | null; staff: string[] }> }>
}

const WIDTH = 1080
const PAD = 48
const INK = '#18211d'
const MUTED = '#667169'
const RULE = '#d9d5c9'
const DAY_COLUMN = 304
const TIME_COLUMN = 288
const GAP = 24

const KL = 'Asia/Kuala_Lumpur'

function hhmm(value: string): string {
  const [h, m] = value.split(':').map(Number)
  return `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`
}

function updatedText(iso: string): string {
  return new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: KL }).format(new Date(iso))
}

export async function rosterPng(roster: RosterExport): Promise<Buffer> {
  const parts: string[] = []
  let y = PAD

  // Heading, with DRAFT on the right while staff cannot see it yet.
  const kicker: TextStyle = { size: 24, weight: 700, fill: MUTED, tracking: 0.12 }
  parts.push(textPath(roster.businessName.toUpperCase(), PAD, baseline(y, 32, 24, 700), kicker))
  y += 32 + 4
  const title: TextStyle = { size: 60, weight: 900, fill: INK }
  const titleLines = wrap(`Roster · ${roster.label}`, WIDTH - PAD * 2 - (roster.isPublished ? 0 : 150), title)
  for (const line of titleLines) {
    parts.push(textPath(line, PAD, baseline(y, 60, 60, 900), title))
    y += 60
  }
  if (!roster.isPublished) {
    const badge: TextStyle = { size: 24, weight: 900, fill: '#92400e' }
    const w = measure('DRAFT', badge) + 32
    parts.push(`<rect x="${WIDTH - PAD - w}" y="${y - 48}" width="${w}" height="48" fill="#fef3c7"/>`)
    parts.push(textPath('DRAFT', WIDTH - PAD - w + 16, baseline(y - 48, 48, 24, 900), badge))
  }
  y += 20
  parts.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - PAD * 2}" height="4" fill="#173a33"/>`)
  y += 4 + 24

  // One row per day.
  const day: TextStyle = { size: 30, weight: 900, fill: INK }
  const time: TextStyle = { size: 30, weight: 700, fill: INK }
  const names: TextStyle = { size: 30, weight: 400, fill: INK }
  const empty: TextStyle = { size: 30, weight: 700, fill: '#c2410c' }
  const note: TextStyle = { size: 30, weight: 400, fill: MUTED }
  const nameX = PAD + DAY_COLUMN + GAP + TIME_COLUMN + GAP
  const nameWidth = WIDTH - PAD - nameX
  roster.days.forEach((entry, index) => {
    const top = y
    parts.push(textPath(entry.label, PAD, baseline(top, 36, 30, 900), day))
    let row = top
    if (entry.shifts.length === 0) {
      parts.push(textPath('No shifts', PAD + DAY_COLUMN + GAP, baseline(row, 32, 24), { size: 24, weight: 400, fill: MUTED }))
      row += 36
    }
    entry.shifts.forEach((shift, n) => {
      if (n > 0) row += 8
      parts.push(textPath(`${hhmm(shift.startTime)}–${hhmm(shift.endTime)}`, PAD + DAY_COLUMN + GAP, baseline(row, 36, 30, 700), time))
      const who = shift.staff.length === 0 ? 'Not filled yet' : shift.staff.join(', ')
      const label = shift.label ? ` · ${shift.label}` : ''
      // Names first; the shift's label follows in grey, wrapping with them.
      const lines = wrap(who + label, nameWidth, names)
      let used = 0
      for (const line of lines) {
        const lineY = baseline(row, 36, 30)
        const nameChars = Math.max(0, Math.min(line.length, who.length - used))
        const namePart = line.slice(0, nameChars)
        const rest = line.slice(nameChars)
        const style = shift.staff.length === 0 ? empty : names
        if (namePart) parts.push(textPath(namePart, nameX, lineY, style))
        if (rest) parts.push(textPath(rest, nameX + (namePart ? measure(namePart, style) : 0), lineY, note))
        used += line.length + 1
        row += 36
      }
    })
    y = Math.max(top + 36, row)
    if (index < roster.days.length - 1) {
      y += 16
      parts.push(`<rect x="${PAD}" y="${y}" width="${WIDTH - PAD * 2}" height="1" fill="${RULE}"/>`)
      y += 1 + 16
    }
  })

  y += 32
  parts.push(textPath(`Last updated: ${updatedText(roster.updatedAt)}`, PAD, baseline(y, 32, 24, 700), { size: 24, weight: 700, fill: MUTED }))
  y += 32 + PAD

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${Math.ceil(y)}"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join('')}</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/** The same picture on an A4 page, for printing. */
export async function rosterPdf(roster: RosterExport): Promise<Buffer> {
  const png = await rosterPng(roster)
  const { width = WIDTH, height = 1 } = await sharp(png).metadata()
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 10
  const pageW = doc.internal.pageSize.getWidth() - margin * 2
  const pageH = doc.internal.pageSize.getHeight() - margin * 2
  const scale = Math.min(pageW / width, pageH / height)
  // As JPEG: the PNG embedded as-is makes a PDF of several megabytes.
  const jpeg = await sharp(png).jpeg({ quality: 90 }).toBuffer()
  doc.addImage(jpeg.toString('base64'), 'JPEG', margin, margin, width * scale, height * scale)
  return Buffer.from(doc.output('arraybuffer'))
}
