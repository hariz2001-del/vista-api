import { describe, expect, it } from 'vitest'
import { lineAmountSen, payableMinutes, periodContaining, recentPeriods, resolveRate } from '../src/domain/payroll.ts'
import {
  DEFAULT_WEIGHTS,
  evaluateRoster,
  generateRoster,
  rankReplacements,
  type EngineInput,
  type EngineSlot,
  type EngineStaff,
} from '../src/domain/rostering.ts'
import { mondayOf, mytDate, mytTime, rangeLabel, shiftInstants, weekdayOf } from '../src/domain/team-time.ts'

describe('team time', () => {
  it('turns Malaysia wall-clock times into instants, past midnight included', () => {
    const { startsAt, endsAt } = shiftInstants('2026-10-03', '22:00', '02:00')
    expect(startsAt.toISOString()).toBe('2026-10-03T14:00:00.000Z')
    expect(endsAt.toISOString()).toBe('2026-10-03T18:00:00.000Z')
    expect(mytDate(endsAt)).toBe('2026-10-04')
    expect(mytTime(startsAt)).toBe('22:00')
  })

  it('knows Mondays and labels ranges', () => {
    expect(weekdayOf('2026-10-05')).toBe(0)
    expect(weekdayOf('2026-10-04')).toBe(6)
    expect(mondayOf('2026-10-04')).toBe('2026-09-28')
    expect(rangeLabel('2026-09-21', '2026-09-27')).toBe('21–27 Sept')
    expect(rangeLabel('2026-09-28', '2026-10-04')).toBe('28 Sept – 4 Oct')
  })
})

describe('payroll arithmetic', () => {
  const at = (time: string) => new Date(`2026-10-03T${time}:00+08:00`)

  it('pays time from timestamps, rounded as the business chose', () => {
    const half = { minutes: 30, mode: 'FLOOR' as const }
    expect(payableMinutes(at('17:00'), at('22:20'), half)).toBe(300)
    expect(payableMinutes(at('17:00'), at('22:30'), half)).toBe(330)
    expect(payableMinutes(at('16:30'), at('21:00'), half)).toBe(270)
    expect(payableMinutes(at('17:00'), at('22:20'), { minutes: 30, mode: 'NEAREST' })).toBe(330)
    expect(payableMinutes(at('17:00'), at('22:07'), { minutes: 1, mode: 'FLOOR' })).toBe(307)
  })

  it('prices lines in whole sen: the brief’s RM 58.50 example', () => {
    expect(lineAmountSen(240, 500)).toBe(2000) // Training 4h × RM5
    expect(lineAmountSen(330, 700)).toBe(3850) // Regular 5.5h × RM7
    expect(lineAmountSen(240, 500) + lineAmountSen(330, 700)).toBe(5850)
    expect(lineAmountSen(25, 700)).toBe(292) // 291.67 rounds to 292
  })

  it('resolves the most specific rate', () => {
    const regular = { name: 'Regular', rateSenPerHour: 700 }
    const training = { name: 'Training', rateSenPerHour: 500 }
    const base = {
      rateOverrideSen: null,
      attendanceWorkType: null,
      assignmentWorkType: null,
      slotWorkType: null,
      staffDefaultWorkType: regular,
    }
    expect(resolveRate(base)).toEqual({ workTypeName: 'Regular', rateSenPerHour: 700, overridden: false })
    expect(resolveRate({ ...base, assignmentWorkType: training })?.rateSenPerHour).toBe(500)
    expect(resolveRate({ ...base, assignmentWorkType: training, rateOverrideSen: 1200 })).toEqual({
      workTypeName: 'Training (special rate)',
      rateSenPerHour: 1200,
      overridden: true,
    })
    expect(resolveRate({ ...base, staffDefaultWorkType: null })).toBeNull()
  })

  it('counts pay periods from the anchor', () => {
    expect(periodContaining('2026-09-24', 'WEEKLY', '2026-01-05')).toEqual({ start: '2026-09-21', end: '2026-09-27' })
    expect(periodContaining('2026-09-24', 'BIWEEKLY', '2026-01-05')).toEqual({ start: '2026-09-14', end: '2026-09-27' })
    expect(periodContaining('2026-09-24', 'MONTHLY', '2026-01-25')).toEqual({ start: '2026-08-25', end: '2026-09-24' })
    expect(periodContaining('2026-09-25', 'MONTHLY', '2026-01-25')).toEqual({ start: '2026-09-25', end: '2026-10-24' })
    expect(periodContaining('2026-02-15', 'MONTHLY', '2026-01-31')?.start).toBe('2026-01-31')
    expect(periodContaining('2026-03-01', 'MONTHLY', '2026-01-31')).toEqual({ start: '2026-02-28', end: '2026-03-30' })
    expect(periodContaining('2026-09-24', 'CUSTOM', '2026-01-05')).toBeNull()
    expect(recentPeriods('2026-09-24', 'WEEKLY', '2026-01-05', 3).map((p) => p.start)).toEqual([
      '2026-09-21',
      '2026-09-14',
      '2026-09-07',
    ])
  })
})

// ---------------------------------------------------------------------------
// The rostering engine
// ---------------------------------------------------------------------------

const HOUR = 3_600_000
const base = Date.UTC(2026, 9, 5, 9) // a Monday, 17:00 in Malaysia

function slot(id: string, day: number, hours = 5, requiredStaff = 1, extra: Partial<EngineSlot> = {}): EngineSlot {
  const startsAt = base + day * 24 * HOUR
  return { id, startsAt, endsAt: startsAt + hours * HOUR, requiredStaff, canRunSolo: true, roleTags: [], ...extra }
}

function person(id: string, attributes: Partial<NonNullable<EngineStaff['attributes']>> | null = null, roleTags: string[] = []): EngineStaff {
  return {
    id,
    name: id,
    roleTags,
    attributes: attributes
      ? {
          reliability: null,
          capability: null,
          experience: null,
          soloSuitability: 'SUITABLE',
          trainingStatus: 'TRAINED',
          managementPriority: 0,
          ...attributes,
        }
      : null,
  }
}

function input(staff: EngineStaff[], slots: EngineSlot[], applied: Record<string, string[]>, extra: Partial<EngineInput> = {}): EngineInput {
  return {
    staff,
    slots,
    applications: new Map(Object.entries(applied).map(([slotId, ids]) => [slotId, new Set(ids)])),
    locked: [],
    limits: { targetShifts: 5, maxShifts: 7, maxMinutes: 45 * 60 },
    weights: DEFAULT_WEIGHTS,
    ...extra,
  }
}

const countFor = (assignments: Array<{ staffId: string }>, id: string) =>
  assignments.filter((assignment) => assignment.staffId === id).length

describe('rostering engine', () => {
  it('shares shifts out rather than giving the best-rated person all of them', () => {
    const slots = [0, 1, 2, 3, 4, 5].map((day) => slot(`d${day}`, day))
    const everyone = Object.fromEntries(slots.map((s) => [s.id, ['star', 'b', 'c']]))
    const result = generateRoster(
      input([person('star', { reliability: 5, capability: 5, managementPriority: 2 }), person('b'), person('c')], slots, everyone),
    )
    expect(result.assignments).toHaveLength(6)
    expect(['star', 'b', 'c'].map((id) => countFor(result.assignments, id))).toEqual([2, 2, 2])
  })

  it('gives more to someone who offered more, but not everything', () => {
    const slots = Array.from({ length: 8 }, (_, index) => slot(`s${index}`, index % 7, 4, 1, { startsAt: base + index * 24 * HOUR, endsAt: base + index * 24 * HOUR + 4 * HOUR }))
    const applied: Record<string, string[]> = {}
    slots.forEach((s, index) => (applied[s.id] = index < 4 ? ['many', 'few'] : ['many']))
    const result = generateRoster(input([person('many'), person('few')], slots, applied))
    expect(countFor(result.assignments, 'many')).toBeGreaterThan(countFor(result.assignments, 'few'))
    expect(countFor(result.assignments, 'few')).toBeGreaterThan(0)
  })

  it('never assigns anyone who did not apply, or two shifts at once, or past the limits', () => {
    const slots = [slot('a', 0, 5), { ...slot('b', 0, 5), id: 'b' }, slot('c', 1), slot('d', 2)]
    const result = generateRoster(
      input([person('x'), person('y')], slots, { a: ['x'], b: ['x'], c: ['x'], d: ['x'] }, {
        limits: { targetShifts: 1, maxShifts: 2, maxMinutes: 600 },
      }),
    )
    expect(result.assignments.every((assignment) => assignment.staffId === 'x')).toBe(true)
    // a and b overlap, so at most one; and at most 2 shifts.
    expect(result.assignments.filter((assignment) => ['a', 'b'].includes(assignment.slotId))).toHaveLength(1)
    expect(result.assignments).toHaveLength(2)
  })

  it('keeps a not-recommended person off solo shifts when someone else applied', () => {
    const result = generateRoster(
      input([person('risky', { soloSuitability: 'NOT_RECOMMENDED' }), person('steady')], [slot('solo', 0, 5, 1), slot('pair', 1, 5, 2)], {
        solo: ['risky', 'steady'],
        pair: ['risky', 'steady'],
      }),
    )
    const solo = result.assignments.find((assignment) => assignment.slotId === 'solo')
    expect(solo?.staffId).toBe('steady')
  })

  it('builds around locked assignments and never moves them', () => {
    const slots = [slot('sat', 5), slot('sun', 6)]
    const result = generateRoster(
      input([person('aina'), person('amir')], slots, { sat: ['amir'], sun: ['aina', 'amir'] }, {
        locked: [{ slotId: 'sat', staffId: 'aina' }],
      }),
    )
    expect(result.assignments.some((assignment) => assignment.slotId === 'sat')).toBe(false)
    expect(result.assignments.find((assignment) => assignment.slotId === 'sun')?.staffId).toBe('amir')
  })

  it('is deterministic and explains itself', () => {
    const slots = [0, 1, 2, 3].map((day) => slot(`d${day}`, day))
    const applied = Object.fromEntries(slots.map((s) => [s.id, ['a', 'b']]))
    const data = input([person('a'), person('b')], slots, applied)
    expect(generateRoster(data).assignments).toEqual(generateRoster(data).assignments)
    expect(generateRoster(data).assignments[0]?.explanation).toMatch(/^Applied for this shift/)
  })

  it('warns, without blocking, about what management should look at', () => {
    const data = input(
      [person('t1', { trainingStatus: 'TRAINEE' }), person('t2', { trainingStatus: 'TRAINEE', soloSuitability: 'NOT_RECOMMENDED' })],
      [slot('pair', 0, 5, 2), slot('solo', 1, 5, 1, { canRunSolo: false }), slot('empty', 2)],
      { pair: ['t1', 't2'], solo: ['t2'] },
    )
    const { warnings, fairness } = evaluateRoster(data, [
      { slotId: 'pair', staffId: 't1' },
      { slotId: 'pair', staffId: 't2' },
      { slotId: 'solo', staffId: 't2' },
      { slotId: 'solo', staffId: 't1' },
    ])
    const kinds = warnings.map((warning) => warning.kind)
    expect(kinds).toContain('TRAINEE_ALONE')
    expect(kinds).toContain('UNFILLED')
    expect(kinds).toContain('OVERSTAFFED')
    expect(kinds).toContain('DID_NOT_APPLY')
    expect(fairness.find((entry) => entry.staffId === 't2')).toMatchObject({ appliedShifts: 2, assignedShifts: 2, fillRate: 1 })
  })

  it('queues replacements: applicants first, then free people, never a clash', () => {
    const data = input([person('gone'), person('applied'), person('free'), person('busy')], [slot('sat', 5), { ...slot('sat2', 5), id: 'sat2' }], {
      sat: ['gone', 'applied'],
    })
    const queue = rankReplacements(data, [{ slotId: 'sat2', staffId: 'busy' }], 'sat', new Set(['gone']))
    expect(queue.map((candidate) => candidate.staffId)).toEqual(['applied', 'free'])
    expect(queue[0]?.appliedForSlot).toBe(true)
  })
})
