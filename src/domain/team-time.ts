/**
 * Clock arithmetic for the Team module, in Malaysia time.
 *
 * Malaysia is UTC+8 all year with no daylight saving, so a wall-clock time
 * converts to an instant by a fixed offset — no timezone database needed.
 * Every instant is stored as a real timestamp; these helpers only translate
 * between "Saturday 17:30" and that instant.
 */

const OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` + `HH:MM` in Malaysia → the instant. */
export function mytInstant(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  if (!y || !m || !d || hh === undefined || mm === undefined) throw new Error(`bad date/time ${date} ${time}`)
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - OFFSET_MS)
}

/** The Malaysia calendar date an instant falls on. */
export function mytDate(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(0, 10)
}

/** The Malaysia wall-clock time of an instant, `HH:MM`. */
export function mytTime(instant: Date): string {
  return new Date(instant.getTime() + OFFSET_MS).toISOString().slice(11, 16)
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const sundayFirst = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()
  return (sundayFirst + 6) % 7
}

/** The Monday of the week a date is in. */
export function mondayOf(date: string): string {
  return addDays(date, -weekdayOf(date))
}

export function isMonday(date: string): boolean {
  return weekdayOf(date) === 0
}

/**
 * A shift on `date` from `start` to `end`. An end at or before the start runs
 * past midnight into the next day, so 22:00–02:00 is four hours, not minus 20.
 */
export function shiftInstants(date: string, start: string, end: string): { startsAt: Date; endsAt: Date } {
  const startsAt = mytInstant(date, start)
  let endsAt = mytInstant(date, end)
  if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + DAY_MS)
  return { startsAt, endsAt }
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000)
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

function dayLabel(date: string, withMonth: boolean): string {
  return new Intl.DateTimeFormat('en-MY', {
    day: 'numeric',
    ...(withMonth ? { month: 'short' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

/** A date range label: "21–27 Sept", "28 Sept – 4 Oct". */
export function rangeLabel(start: string, end: string): string {
  if (start === end) return dayLabel(start, true)
  return start.slice(0, 7) === end.slice(0, 7)
    ? `${dayLabel(start, false)}–${dayLabel(end, true)}`
    : `${dayLabel(start, true)} – ${dayLabel(end, true)}`
}
