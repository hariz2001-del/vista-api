import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { DomainError } from '../errors.ts'

type Report = { title: string; subtitle: string; columns: string[]; rows: string[][] }
const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
const query = z.object({
  kind: z.enum(['stock-checklist', 'stock-count', 'roster', 'expenses', 'sales', 'audit']),
  format: z.enum(['pdf', 'png']).default('pdf'), id: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

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
    let report: Report
    if (args.kind === 'roster') {
      if (!args.id) throw new DomainError('validation:INVALID_REQUEST', 400, 'Choose a roster week ID first.')
      const data = await read(request, `/agent/team/weeks/${args.id}/export`)
      report = { title: 'Staff roster', subtitle: `${business} · ${data.label} · ${data.isPublished ? 'Published' : 'Draft'}`, columns: ['Date', 'Time', 'Shift', 'Staff'], rows: data.days.flatMap((day: any) => day.shifts.length ? day.shifts.map((shift: any) => [day.label, `${shift.startTime}–${shift.endTime}`, shift.label ?? '', shift.staff.join(', ') || 'Unfilled']) : [[day.label, '', 'No shifts', '']]) }
    } else if (args.kind === 'stock-count' || args.kind === 'stock-checklist') {
      let items: any[]
      let subtitle = business
      if (args.kind === 'stock-count') {
        if (!args.id) throw new DomainError('validation:INVALID_REQUEST', 400, 'Choose a stock count ID first.')
        const { count } = await read(request, `/agent/stock/counts/${args.id}`)
        items = count.lines
        subtitle += ` · ${count.businessDate} · ${count.staffName}${count.remarks ? ` · ${count.remarks}` : ''}`
      } else {
        const data = await read(request, '/agent/stock/sheet')
        items = data.items.map((item: any) => ({ ...item, brandName: data.brands.find((b: any) => b.id === item.brandId)?.name ?? '' }))
      }
      const balance: Record<string, string> = { EMPTY: '0%', QUARTER: '25%', LESS_THAN_HALF: '25%', HALF: '50%', THREE_QUARTERS: '75%', MORE_THAN_HALF: '75%', FULL: '100%' }
      report = { title: args.kind === 'stock-count' ? 'Closing stock count' : 'Closing stock checklist', subtitle, columns: ['Brand / category', 'Item', 'Unopened', 'Opened balance'], rows: items.map((item) => [ `${item.brandName} / ${item.category}${item.subcategory ? ` / ${item.subcategory}` : ''}`, `${item.name}${item.unitLabel ? ` (${item.unitLabel})` : ''}`, item.trackUnopened ? item.unopenedMilli == null ? '____' : String(item.unopenedMilli / 1000) : '-', item.trackBalance ? balance[item.balance] ?? '____' : '-' ]) }
    } else {
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
      let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${140 + rows.length * 66}"><rect width="100%" height="100%" fill="#faf8f1"/><g font-family="DejaVu Sans,sans-serif" fill="#18352a"><text x="32" y="42" font-size="28" font-weight="bold">${esc(report.title)}</text><text x="32" y="78" font-size="18">${esc(report.subtitle).slice(0, 500)}</text>`
      rows.forEach((row, index) => {
        const y = 106 + index * 66
        svg += `<rect x="24" y="${y}" width="1552" height="64" fill="${index === 0 ? '#dbe8de' : index % 2 ? '#ffffff' : '#f0eee5'}"/>`
        row.forEach((cell, column) => {
          const limit = Math.floor(colWidth / 10)
          const chunks = cell.length > limit ? [cell.slice(0, limit), cell.slice(limit, limit * 2 - 1) + (cell.length > limit * 2 ? '…' : '')] : [cell]
          chunks.forEach((line, n) => { svg += `<text x="${32 + column * colWidth}" y="${y + 25 + n * 22}" font-size="17">${esc(line)}</text>` })
        })
      })
      svg += '</g></svg>'
      bytes = await sharp(Buffer.from(svg)).png().toBuffer()
    }
    if (bytes.length > 3 * 1024 * 1024) throw new DomainError('agent:REPORT_TOO_LARGE', 400, 'Choose a shorter report or PDF output; the generated image is too large.')
    return { filename: `${args.kind}-${args.id ?? args.from ?? 'latest'}.${args.format}`, mimeType: args.format === 'pdf' ? 'application/pdf' : 'image/png', contentBase64: bytes.toString('base64'), rows: report.rows.length }
  })
}
