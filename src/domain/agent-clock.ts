import { getBusinessDate } from './business-date.ts'

export function agentClock(now: Date, cutoffHour: number) {
  const zone = 'Asia/Kuala_Lumpur'
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]))
  const calendarDate = `${parts.year}-${parts.month}-${parts.day}`
  return {
    timezone: zone, utcOffset: '+08:00', utcNow: now.toISOString(),
    localNow: `${calendarDate}T${parts.hour}:${parts.minute}:${parts.second}+08:00`,
    calendarDate, weekday: new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long' }).format(now),
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    businessDate: getBusinessDate(now, cutoffHour), dayRolloverHour: cutoffHour,
    note: 'Calendar today is calendarDate. Vista sales/ledger are indexed by businessDate; before the configured rollover the current trading day is the previous calendar date. Never label that previous date as the actual calendar date.',
  }
}
