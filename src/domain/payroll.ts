import { addDays, minutesBetween } from './team-time.ts'

/**
 * Payroll arithmetic. Pure, integer sen throughout.
 *
 * Pay is approved attendance × the rate that applies to it. Nothing here
 * assumes whole hours: time is minutes between two timestamps, rounded only
 * as the business chose in its settings.
 */

export type Rounding = { minutes: number; mode: 'FLOOR' | 'NEAREST' }

/**
 * Payable minutes between two instants. With half-hour floor rounding,
 * 17:00–22:20 pays 300 minutes and 17:00–22:30 pays 330.
 */
export function payableMinutes(start: Date, end: Date, rounding: Rounding): number {
  const raw = Math.max(0, minutesBetween(start, end))
  const block = Math.max(1, rounding.minutes)
  return rounding.mode === 'NEAREST' ? Math.round(raw / block) * block : Math.floor(raw / block) * block
}

/** minutes × sen-per-hour ÷ 60, rounded half up to the sen. 330 min × 700 = 3850. */
export function lineAmountSen(minutes: number, rateSenPerHour: number): number {
  return Math.round((minutes * rateSenPerHour) / 60)
}

export type RateSource = {
  /** A one-off rate on the assignment. Wins over everything. */
  rateOverrideSen: number | null
  /** Set on the attendance record by management (unrostered work, or a change). */
  attendanceWorkType: { name: string; rateSenPerHour: number } | null
  assignmentWorkType: { name: string; rateSenPerHour: number } | null
  slotWorkType: { name: string; rateSenPerHour: number } | null
  staffDefaultWorkType: { name: string; rateSenPerHour: number } | null
}

export type ResolvedRate = { workTypeName: string; rateSenPerHour: number; overridden: boolean } | null

/**
 * The rate for one piece of attendance, most specific first: the shift's
 * one-off override, the record's own work type, the assignment's, the slot's,
 * then the person's usual one. Null when nothing names a rate.
 */
export function resolveRate(source: RateSource): ResolvedRate {
  const workType =
    source.attendanceWorkType ?? source.assignmentWorkType ?? source.slotWorkType ?? source.staffDefaultWorkType
  if (source.rateOverrideSen !== null) {
    return {
      workTypeName: `${workType?.name ?? 'Shift'} (special rate)`,
      rateSenPerHour: source.rateOverrideSen,
      overridden: true,
    }
  }
  if (!workType) return null
  return { workTypeName: workType.name, rateSenPerHour: workType.rateSenPerHour, overridden: false }
}

export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM'

/** Whole days from a to b. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The pay period containing `date`, counted from the anchor. Custom has none. */
export function periodContaining(
  date: string,
  frequency: PayFrequency,
  anchor: string,
): { start: string; end: string } | null {
  if (frequency === 'CUSTOM') return null
  if (frequency === 'MONTHLY') {
    // Monthly periods start on the anchor's day of the month (clamped to short months).
    const anchorDay = Number(anchor.slice(8, 10))
    const [y, m, d] = date.split('-').map(Number) as [number, number, number]
    const startIn = (year: number, month: number) => {
      const day = Math.min(anchorDay, lastDayOfMonth(year, month))
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    }
    let start = startIn(y, m)
    if (d < Number(start.slice(8, 10))) {
      const previousMonth = m === 1 ? 12 : m - 1
      start = startIn(m === 1 ? y - 1 : y, previousMonth)
    }
    const [sy, sm] = start.split('-').map(Number) as [number, number]
    const nextStart = startIn(sm === 12 ? sy + 1 : sy, sm === 12 ? 1 : sm + 1)
    return { start, end: addDays(nextStart, -1) }
  }
  const length = frequency === 'WEEKLY' ? 7 : 14
  const offset = ((daysBetween(anchor, date) % length) + length) % length
  const start = addDays(date, -offset)
  return { start, end: addDays(start, length - 1) }
}

/** The current period and the `count − 1` before it, newest first. */
export function recentPeriods(
  today: string,
  frequency: PayFrequency,
  anchor: string,
  count: number,
): Array<{ start: string; end: string }> {
  const periods: Array<{ start: string; end: string }> = []
  let cursor = today
  for (let index = 0; index < count; index += 1) {
    const period = periodContaining(cursor, frequency, anchor)
    if (!period) break
    periods.push(period)
    cursor = addDays(period.start, -1)
  }
  return periods
}
