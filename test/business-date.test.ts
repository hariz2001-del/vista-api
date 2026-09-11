import { describe, expect, it } from 'vitest'
import { businessDateToUtc, getBusinessDate } from '../src/domain/business-date.ts'

/**
 * Malaysia is UTC+8, so 16:00Z is midnight local. These cases are written in
 * UTC on purpose: the bug this guards against is a server in one timezone
 * deciding a sale belongs to a different day than the tablet did.
 */
describe('business date', () => {
  it('books an evening sale to that evening', () => {
    // 2026-09-08 21:30 in Kuala Lumpur
    expect(getBusinessDate(new Date('2026-09-08T13:30:00Z'))).toBe('2026-09-08')
  })

  it('books a post-midnight sale to the night it belongs to', () => {
    // 2026-09-09 01:30 local — still the night that opened on the 8th
    expect(getBusinessDate(new Date('2026-09-08T17:30:00Z'))).toBe('2026-09-08')
  })

  it('rolls over at the 5am cutoff, not at midnight', () => {
    // 04:59 local on the 9th → still the 8th
    expect(getBusinessDate(new Date('2026-09-08T20:59:00Z'))).toBe('2026-09-08')
    // 05:00 local on the 9th → the 9th
    expect(getBusinessDate(new Date('2026-09-08T21:00:00Z'))).toBe('2026-09-09')
  })

  it('crosses a month boundary correctly', () => {
    // 2026-10-01 02:00 local → the trading night of 30 September
    expect(getBusinessDate(new Date('2026-09-30T18:00:00Z'))).toBe('2026-09-30')
  })

  it('crosses a year boundary correctly', () => {
    // 2027-01-01 01:00 local → New Year's Eve trading
    expect(getBusinessDate(new Date('2026-12-31T17:00:00Z'))).toBe('2026-12-31')
  })

  it('survives the round trip to a Postgres date and back', () => {
    for (const date of ['2026-09-08', '2026-01-01', '2026-12-31', '2026-02-28']) {
      expect(businessDateToUtc(date).toISOString().slice(0, 10)).toBe(date)
    }
  })

  it('rejects a malformed date rather than guessing', () => {
    for (const bad of ['not-a-date', '2026-9-8', '', '2026/09/08', '20260908']) {
      expect(() => businessDateToUtc(bad)).toThrow()
    }
  })

  it('rejects a date that does not exist rather than rolling it forward', () => {
    // Date.UTC would quietly turn these into 1 March and 1 May.
    expect(() => businessDateToUtc('2026-02-30')).toThrow()
    expect(() => businessDateToUtc('2026-04-31')).toThrow()
    expect(() => businessDateToUtc('2026-13-01')).toThrow()
  })
})
