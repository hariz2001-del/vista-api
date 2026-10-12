import { expect, it } from 'vitest'
import { agentClock } from '../src/domain/agent-clock.ts'
it('uses the Malaysia calendar, weekday and time regardless of host timezone', () => {
  expect(agentClock(new Date('2026-10-11T16:05:09Z'), 5)).toMatchObject({ calendarDate: '2026-10-12', weekday: 'Monday', localNow: '2026-10-12T00:05:09+08:00', time: '00:05:09', businessDate: '2026-10-11' })
})
it('rolls the trading day at the actual configured hour, not a guessed date', () => {
  expect(agentClock(new Date('2026-10-11T20:59:59Z'), 5).businessDate).toBe('2026-10-11')
  expect(agentClock(new Date('2026-10-11T21:00:00Z'), 5)).toMatchObject({ calendarDate: '2026-10-12', businessDate: '2026-10-12', time: '05:00:00' })
  expect(agentClock(new Date('2026-10-11T18:00:00Z'), 0).businessDate).toBe('2026-10-12')
})
