import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { DomainError } from '../errors.ts'
import { baseline, textPath } from '../documents/text.ts'
import type { MadeFile } from '../documents/send.ts'
import { latestStockCountId, stockChecklistFile, stockCountFile } from './stock.ts'
import { rosterFile } from './team-roster.ts'

type Report = { title: string; subtitle: string; columns: string[]; rows: string[][] }
const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`
const query = z.object({
  kind: z.enum(['stock-checklist', 'stock-count', 'roster', 'expenses', 'sales', 'audit']),
  format: z.enum(['pdf', 'png']).default('pdf'), id: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

/** This week's roster, or the newest one before it, or the next one coming. */
async function currentWeekId(request: FastifyRequest): Promise<string | null> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const day = new Date(`${today}T00:00:00Z`)
  const before = await request.db.rosterWeek.findFirst({ where: { weekStart: { lte: day } }, orderBy: { weekStart: 'desc' }, select: { id: true } })
  if (before) return before.id
  const after = await request.db.rosterWeek.findFirst({ orderBy: { weekStart: 'asc' }, select: { id: true } })
  return after?.id ?? null
}

export async function agentReportRoutes(app: FastifyInstance) {
  async function read(request: FastifyRequest, path: string): Promise<Record<string, any>> {
    const response = await app.inject({ method: 'GET', url: path, headers: { authorization: request.headers.authorization!, 'x-telegram-user': String(request.headers['x-telegram-user']) } })
    if (response.statusCode >= 400) {
      const error = response.json()
      throw new DomainError(error.error ?? 'agent:REPORT_FAILED', response.statusCode, error.message ?? 'Cannot load report data.')
    }
    return response.json()
  }
  app.get('/agent/reports', { preHandler: requireAgent('VIEWER') }, async (request) => {
    const args = query.parse(request.query)
    const settings = await request.db.accountSettings.findUnique({ where: { businessId: request.businessId } })
    const business = settings?.businessName ?? 'Vista'
    const range = new URLSearchParams({ ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}) })
    // Stock and roster: Vista's own files, the same bytes the RMS downloads.
    const made = (file: MadeFile, rows: number | null = null) =>
      ({ filename: file.filename, mimeType: file.mimeType, contentBase64: file.bytes.toString('base64'), rows, madeBy: 'Vista' })
    if (args.kind === 'stock-count') {
      const id = args.id ?? (await latestStockCountId(request.db))
      if (!id) throw new DomainError('stock:COUNT_NOT_FOUND', 404, 'No closing stock count has been sent yet.')
      return made(await stockCountFile(request.db, id))
    }
    if (args.kind === 'stock-checklist') return made(await stockChecklistFile(request.db, request.businessId))
    if (args.kind === 'roster') {
      const id = args.id ?? (await currentWeekId(request))
      if (!id) throw new DomainError('team:WEEK_NOT_FOUND', 404, 'There is no roster week yet.')
      return made(await rosterFile(request.db, request.businessId, id, args.format))
    }
    let report: Report
    {
      const data = await read(request, `/agent/${args.kind}?${range}`)
      const subtitle = `${business} · ${data.from} to ${data.to}`
      if (args.kind === 'expenses') report = { title: 'Expenses', subtitle, columns: ['Date', 'Description / vendor', 'Category', 'Amount', 'Brand'], rows: data.expenses.map((row: any) => [row.date, [row.description, row.vendor].filter(Boolean).join(' / '), row.category, rm(row.amountSen), row.brand]) }
      else if (args.kind === 'sales') report = { title: 'Net sales', subtitle, columns: ['Date', 'Orders', 'Net sales'], rows: data.days.map((row: any) => [row.date, String(row.orders), rm(row.netSen)]) }
      else report = { title: 'Expenses missing receipts', subtitle, columns: ['Date', 'Description / vendor', 'Receipt no.', 'Amount'], rows: data.expensesWithoutReceipt.map((row: any) => [row.businessDate, [row.description, row.vendor].filter(Boolean).join(' / '), row.receiptNo ?? '', rm(row.amountSen)]) }
    }
    if (report.rows.length > 500) throw new DomainError('agent:REPORT_TOO_LARGE', 400, 'Choose a shorter date range; reports support up to 500 rows.')
    let bytes: Buffer
    if (args.format === 'pdf') {
      const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
      const doc = new jsPDF({ orientation: report.columns.length > 4 ? 'landscape' : 'portrait' })
      const latin = (value: string) => value.replace(/–|—/g, '-').replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
      doc.setFontSize(18)
      doc.text(latin(report.title), 14, 20)
      doc.setFontSize(9)
      doc.text(latin(report.subtitle).slice(0, 140), 14, 28)
      autoTable(doc, { startY: 34, head: [report.columns], body: report.rows.map((row) => row.map(latin)), styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [30, 65, 48] }, margin: { top: 14, bottom: 14 } })
      bytes = Buffer.from(doc.output('arraybuffer'))
    } else {
      const { default: sharp } = await import('sharp')
      const width = 1600, colWidth = (width - 64) / report.columns.length
      const rows = [report.columns, ...report.rows]
      // Text as outlines: the hosting has no fonts, so SVG text drew as empty boxes.
      const ink = '#18352a'
      let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${140 + rows.length * 66}"><rect width="100%" height="100%" fill="#faf8f1"/>`
      svg += textPath(report.title, 32, 42, { size: 28, weight: 700, fill: ink }) + textPath(report.subtitle.slice(0, 140), 32, 78, { size: 18, weight: 400, fill: ink })
      rows.forEach((row, index) => {
        const y = 106 + index * 66
        svg += `<rect x="24" y="${y}" width="1552" height="64" fill="${index === 0 ? '#dbe8de' : index % 2 ? '#ffffff' : '#f0eee5'}"/>`
        row.forEach((cell, column) => {
          const limit = Math.floor(colWidth / 10)
          const chunks = cell.length > limit ? [cell.slice(0, limit), cell.slice(limit, limit * 2 - 1) + (cell.length > limit * 2 ? '…' : '')] : [cell]
          chunks.forEach((line, n) => { svg += textPath(line, 32 + column * colWidth, baseline(y + 8 + n * 22, 22, 17), { size: 17, weight: index === 0 ? 700 : 400, fill: ink }) })
        })
      })
      svg += '</svg>'
      bytes = await sharp(Buffer.from(svg)).png().toBuffer()
    }
    if (bytes.length > 3 * 1024 * 1024) throw new DomainError('agent:REPORT_TOO_LARGE', 400, 'Choose a shorter report or PDF output; the generated image is too large.')
    return { filename: `${args.kind}-${args.id ?? args.from ?? 'latest'}.${args.format}`, mimeType: args.format === 'pdf' ? 'application/pdf' : 'image/png', contentBase64: bytes.toString('base64'), rows: report.rows.length }
  })
}
