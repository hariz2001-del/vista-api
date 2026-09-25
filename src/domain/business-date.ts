import type { Tx } from '../db.ts'

const BUSINESS_TIME_ZONE = 'Asia/Kuala_Lumpur'

/**
 * Trading days do not start at midnight. Service runs roughly 8pm to 3am, so a
 * 1am sale belongs to the evening that opened the night before.
 *
 * The default cutoff is 5am: late enough to cover a shift that overruns, early
 * enough that nobody is trading through it. Each business can set its own
 * (`account_settings.day_rollover_hour`); the counter is told it in the
 * bootstrap. This must stay byte-for-byte in agreement with the POS's own
 * implementation, since an offline tablet stamps its own business date with
 * no server to ask.
 */
const CUTOFF_HOUR = 5

type DateParts = {
  year: number
  month: number
  day: number
  hour: number
}

function malaysiaParts(date: Date): DateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  const values: Record<string, string> = {}
  for (const part of parts) values[part.type] = part.value

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  }
}

function isoDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`
}

/** `YYYY-MM-DD` for the trading evening the given instant belongs to. */
export function getBusinessDate(date: Date, cutoffHour = CUTOFF_HOUR): string {
  const parts = malaysiaParts(date)
  if (parts.hour >= cutoffHour) {
    return isoDate(parts.year, parts.month, parts.day)
  }

  // Midday UTC, so the arithmetic cannot slip a day across a timezone edge.
  const priorDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1, 12))
  return isoDate(priorDay.getUTCFullYear(), priorDay.getUTCMonth() + 1, priorDay.getUTCDate())
}

/** Today's business date for one business, by its own rollover hour (5am unless it set another). */
export async function businessToday(client: Tx, businessId: string): Promise<string> {
  const settings = await client.accountSettings.findUnique({ where: { businessId } })
  return getBusinessDate(new Date(), settings?.dayRolloverHour ?? CUTOFF_HOUR)
}

/**
 * A `YYYY-MM-DD` business date as a `Date` for Postgres `@db.Date`, pinned to
 * midday UTC so no timezone conversion can move it onto an adjacent day.
 */
export function businessDateToUtc(businessDate: string): Date {
  // Checked strictly. `Number('not')` is NaN rather than undefined, so a loose
  // guard lets a malformed date through as an Invalid Date that only fails much
  // later, somewhere far less obvious than here.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate)
  if (!match) throw new Error(`Invalid business date: ${businessDate}`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  const date = new Date(Date.UTC(year, month - 1, day, 12))
  // Rejects 2026-02-30 and friends, which Date.UTC would silently roll forward.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid business date: ${businessDate}`)
  }

  return date
}
