/**
 * Sheet rows → campaign orders. Pure: no database, no network.
 *
 * Which column holds what is the campaign's configuration (`columns`, by header
 * name), never code, so another campaign's sheet with other headings works
 * without a change here. Rows sharing an order reference become one order; each
 * row is one line, and a row's coupon code belongs to that line.
 */

export type SheetColumns = {
  orderRef: string
  customerName: string
  submittedAt?: string
  contact?: string
  product?: string
  total?: string
  proof?: string
  status?: string
  coupon?: string
  /** The "voucher used" tick Vista writes back (not read). */
  redeemed?: string
  /** Per line: what the customer wrote, its lettering style, and the design preview link (see artwork.ts). */
  message?: string
  messageStyle?: string
  design?: string
}

export type SheetConfig = {
  columns: SheetColumns
  /** Whether the total column is the whole order's total (repeated on each row) or each line's. */
  totalPer?: 'ORDER' | 'LINE'
  /** Columns shown as pickup/fulfilment details. */
  fulfilmentColumns?: string[]
}

export type ImportedLine = {
  lineNo: number
  label: string
  priceSen: number | null
  coupon: string | null
  details: Record<string, string>
}

export type ImportedOrder = {
  externalRef: string
  customerName: string
  contact: string | null
  submittedAt: Date | null
  totalSen: number | null
  proofUrl: string | null
  sourceStatus: string | null
  fulfilment: Record<string, string>
  sourceData: Record<string, string>[]
  lines: ImportedLine[]
}

export type ParseResult = { orders: ImportedOrder[]; skipped: Array<{ row: number; reason: string }> }

/** A HYPERLINK formula's link and label; anything else is its own text. */
export function cellParts(value: unknown): { text: string; link: string | null } {
  if (value === null || value === undefined) return { text: '', link: null }
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), link: null }
  const raw = String(value)
  const link = /^=HYPERLINK\(\s*"((?:[^"]|"")*)"\s*(?:[,;]\s*"((?:[^"]|"")*)")?\s*\)\s*$/i.exec(raw)
  if (link) return { link: link[1]!.replace(/""/g, '"'), text: (link[2] ?? link[1]!).replace(/""/g, '"') }
  if (raw.startsWith('=')) return { text: '', link: null } // some other formula: no plain value to read
  return { text: raw.trim(), link: null }
}

/** RM in a cell (24, "24", "RM 24.00", "1,024.50") → sen. */
export function ringgitToSen(text: string): number | null {
  const cleaned = text.replace(/RM/i, '').replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const sen = Math.round(Number(cleaned) * 100)
  return sen >= 0 ? sen : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * A submitted-at cell in the business's own clock (UTC+8, no DST) → instant.
 * Reads "17/11/2026 14:05", "17/11/2026, 14:05", "2026-11-17 14:05", "17 Nov 2026 2:05 PM".
 */
export function parseLocalDateTime(text: string, offsetMinutes = 480): Date | null {
  const value = text.trim()
  let year: number, month: number, day: number
  let rest: string
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]*(.*)$/.exec(value)
  if (match) {
    day = +match[1]!
    month = +match[2]!
    year = +match[3]!
    rest = match[4]!
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})[T,\s]*(.*)$/.exec(value))) {
    year = +match[1]!
    month = +match[2]!
    day = +match[3]!
    rest = match[4]!
  } else if ((match = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})[,\s]*(.*)$/.exec(value))) {
    day = +match[1]!
    month = MONTHS.indexOf(match[2]!.toLowerCase()) + 1
    year = +match[3]!
    rest = match[4]!
  } else {
    return null
  }
  let hour = 0
  let minute = 0
  const time = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?/i.exec(rest.trim())
  if (time) {
    hour = +time[1]!
    minute = +time[2]!
    const half = time[3]?.toLowerCase()
    if (half === 'pm' && hour < 12) hour += 12
    if (half === 'am' && hour === 12) hour = 0
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const utc = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000
  const date = new Date(utc)
  // Reject 31/02 and friends rather than let them roll into the next month.
  const local = new Date(utc + offsetMinutes * 60_000)
  if (local.getUTCDate() !== day || local.getUTCMonth() !== month - 1) return null
  return date
}

export function parseSheet(rows: unknown[][], config: SheetConfig): ParseResult {
  const skipped: ParseResult['skipped'] = []
  const [header, ...body] = rows
  if (!header) return { orders: [], skipped }
  const headers = header.map((cell) => cellParts(cell).text)
  const index = (name: string | undefined) => (name ? headers.indexOf(name) : -1)
  const column = Object.fromEntries(
    (Object.keys(config.columns) as Array<keyof SheetColumns>).map((key) => [key, index(config.columns[key])]),
  ) as Record<keyof SheetColumns, number>
  for (const required of ['orderRef', 'customerName'] as const) {
    if (column[required] < 0) throw new Error(`the sheet has no "${config.columns[required]}" column`)
  }
  const fulfilment = (config.fulfilmentColumns ?? []).map((name) => [name, index(name)] as const).filter(([, at]) => at >= 0)

  const orders = new Map<string, ImportedOrder>()
  body.forEach((row, offset) => {
    const at = (i: number) => (i >= 0 ? cellParts(row[i]) : { text: '', link: null })
    const ref = at(column.orderRef).text
    if (!ref) {
      if (row.some((cell) => cellParts(cell).text)) skipped.push({ row: offset + 2, reason: 'no order reference' })
      return
    }
    const sourceData: Record<string, string> = {}
    headers.forEach((name, i) => {
      if (!name) return
      const parts = cellParts(row[i])
      if (parts.text || parts.link) sourceData[name] = parts.link && parts.text !== parts.link ? `${parts.text} <${parts.link}>` : parts.text || parts.link!
    })
    const total = column.total >= 0 ? ringgitToSen(at(column.total).text) : null
    const details: Record<string, string> = {}
    for (const [name, i] of fulfilment) if (at(i).text) details[name] = at(i).text

    let order = orders.get(ref)
    if (!order) {
      const contact = at(column.contact)
      order = {
        externalRef: ref,
        customerName: at(column.customerName).text || '(no name)',
        contact: contact.text || contact.link || null,
        submittedAt: column.submittedAt >= 0 ? parseLocalDateTime(at(column.submittedAt).text) : null,
        totalSen: config.totalPer === 'LINE' ? 0 : total,
        proofUrl: at(column.proof).link ?? (/^https?:\/\//.test(at(column.proof).text) ? at(column.proof).text : null),
        sourceStatus: at(column.status).text || null,
        fulfilment: details,
        sourceData: [],
        lines: [],
      }
      orders.set(ref, order)
    }
    if (config.totalPer === 'LINE') order.totalSen = total === null || order.totalSen === null ? null : order.totalSen + total
    order.sourceData.push(sourceData)
    order.lines.push({
      lineNo: order.lines.length + 1,
      label: at(column.product).text || `Item ${order.lines.length + 1}`,
      priceSen: config.totalPer === 'LINE' ? total : null,
      coupon: at(column.coupon).text || null,
      details: sourceData,
    })
  })
  return { orders: [...orders.values()], skipped }
}
