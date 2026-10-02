import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { addDays, mondayOf, mytDate } from '../src/domain/team-time.ts'
import { authed, makeApp, makeBusiness, resetTransactional, type TestBusiness } from './helpers.ts'

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

beforeEach(async () => {
  await resetTransactional()
})

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
async function call(token: string | null, method: Method, url: string, payload?: object) {
  const response = await app.inject({
    method,
    url,
    ...(token ? { headers: authed(token) } : {}),
    ...(payload ? { payload } : {}),
  })
  return response
}
async function ok<T = Record<string, unknown>>(token: string, method: Method, url: string, payload?: object): Promise<T> {
  const response = await call(token, method, url, payload)
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200)
  return response.json() as T
}

const CONFIDENTIAL = /reliability|capability|soloSuitability|managementPriority|trainingStatus|"notes"|explanation|engineWeights|SECRET|rateOverride|fairShare|"score"/

type Team = {
  b: TestBusiness
  regular: string
  training: string
  staff: Record<string, { id: string; token: string }>
}

/** A business with Regular and Training work types and the named staff signed in. */
async function team(names: string[]): Promise<Team> {
  const b = await makeBusiness(app)
  const regular = (await ok<{ workType: { id: string } }>(b.ownerToken, 'POST', '/rms/team/work-types', { name: 'Regular', rateSenPerHour: 700 })).workType.id
  const training = (await ok<{ workType: { id: string } }>(b.ownerToken, 'POST', '/rms/team/work-types', { name: 'Training', rateSenPerHour: 500 })).workType.id
  const staff: Team['staff'] = {}
  for (const name of names) {
    const created = await ok<{ staff: { id: string }; pin: string }>(b.ownerToken, 'POST', '/rms/team/staff', { name, defaultWorkTypeId: regular })
    const signIn = await call(null, 'POST', '/team/auth/login', { orgId: b.businessId, who: name, pin: created.pin })
    expect(signIn.statusCode, signIn.body).toBe(200)
    const login = signIn.json() as { token: string }
    staff[name] = { id: created.staff.id, token: login.token }
  }
  return { b, regular, training, staff }
}

/** A Monday comfortably in the future, so deadlines have not passed. */
function futureMonday(weeksAhead = 3): string {
  return addDays(mondayOf(mytDate(new Date())), 7 * weeksAhead)
}

type WeekDetail = {
  week: { id: string; status: string; version: number }
  slots: Array<{ id: string; date: string; startTime: string; endTime: string; minutes: number; assignments: Array<{ id: string; staffId: string; status: string; isLocked: boolean; explanation: string | null }>; applicants: Array<{ staffId: string }> }>
  warnings: Array<{ kind: string; staffId: string | null; message: string }>
  fairness: Array<{ staffId: string; assignedShifts: number; appliedShifts: number }>
}

async function openWeek(t: Team, weekStart: string, shifts: Array<{ day: number; start: string; end: string; required?: number }>) {
  const created = await ok<WeekDetail>(t.b.ownerToken, 'POST', '/rms/team/weeks', { weekStart, fromTemplate: false })
  for (const shift of shifts) {
    await ok(t.b.ownerToken, 'POST', `/rms/team/weeks/${created.week.id}/slots`, {
      date: addDays(weekStart, shift.day),
      startTime: shift.start,
      endTime: shift.end,
      requiredStaff: shift.required ?? 1,
    })
  }
  return ok<WeekDetail>(t.b.ownerToken, 'POST', `/rms/team/weeks/${created.week.id}/status`, { status: 'APPLICATIONS_OPEN' })
}

describe('team — timetable and applications', () => {
  it('stamps a week out of the usual shifts, skipping closed days, at any minute', async () => {
    const t = await team([])
    await ok(t.b.ownerToken, 'PUT', '/rms/team/operating-hours', {
      days: [{ weekday: 1, isClosed: true, opensAt: '16:00', closesAt: '23:00' }],
    })
    await ok(t.b.ownerToken, 'PUT', '/rms/team/slot-templates', {
      templates: [0, 1, 2].map((weekday) => ({ weekday, startTime: '16:30', endTime: '21:00', requiredStaff: 2 })).concat([
        { weekday: 5, startTime: '22:00', endTime: '02:00', requiredStaff: 1 },
      ]),
    })
    const weekStart = futureMonday()
    expect((await call(t.b.ownerToken, 'POST', '/rms/team/weeks', { weekStart: addDays(weekStart, 1) })).statusCode).toBe(400)

    const week = await ok<WeekDetail>(t.b.ownerToken, 'POST', '/rms/team/weeks', { weekStart })
    // Monday, Wednesday and Saturday night — Tuesday is closed.
    expect(week.slots.map((slot) => [slot.date, slot.startTime, slot.endTime, slot.minutes])).toEqual([
      [weekStart, '16:30', '21:00', 270],
      [addDays(weekStart, 2), '16:30', '21:00', 270],
      [addDays(weekStart, 5), '22:00', '02:00', 240],
    ])
    expect((await call(t.b.ownerToken, 'POST', '/rms/team/weeks', { weekStart })).statusCode).toBe(409)
  })

  it('lets staff apply only while applications are open and up to the limit', async () => {
    const t = await team(['Aina'])
    const weekStart = futureMonday()
    const draft = await ok<WeekDetail>(t.b.ownerToken, 'POST', '/rms/team/weeks', { weekStart, fromTemplate: false })
    for (const day of [0, 1, 2]) {
      await ok(t.b.ownerToken, 'POST', `/rms/team/weeks/${draft.week.id}/slots`, { date: addDays(weekStart, day), startTime: '17:00', endTime: '22:00' })
    }
    const aina = t.staff.Aina!.token
    // A draft week is invisible to staff.
    expect((await ok<{ weeks: unknown[] }>(aina, 'GET', '/team/weeks')).weeks).toHaveLength(0)

    await ok(t.b.ownerToken, 'PATCH', `/rms/team/weeks/${draft.week.id}`, { applicationLimit: 2 })
    const opened = await ok<WeekDetail>(t.b.ownerToken, 'POST', `/rms/team/weeks/${draft.week.id}/status`, { status: 'APPLICATIONS_OPEN' })
    const [s1, s2, s3] = opened.slots.map((slot) => slot.id)
    await ok(aina, 'POST', `/team/slots/${s1}/apply`)
    await ok(aina, 'POST', `/team/slots/${s2}/apply`)
    const third = await call(aina, 'POST', `/team/slots/${s3}/apply`)
    expect(third.statusCode).toBe(409)
    expect(third.json().error).toBe('team:APPLICATION_LIMIT')
    // Taking one back frees a place.
    await ok(aina, 'DELETE', `/team/slots/${s1}/apply`)
    await ok(aina, 'POST', `/team/slots/${s3}/apply`)

    const mine = await ok<{ weeks: Array<{ appliedCount: number; slots: Array<{ myStatus: string }> }> }>(aina, 'GET', '/team/weeks')
    expect(mine.weeks[0]?.appliedCount).toBe(2)
    expect(mine.weeks[0]?.slots.map((slot) => slot.myStatus)).toEqual(['AVAILABLE', 'APPLIED', 'APPLIED'])

    await ok(t.b.ownerToken, 'POST', `/rms/team/weeks/${draft.week.id}/status`, { status: 'APPLICATIONS_CLOSED' })
    expect((await call(aina, 'POST', `/team/slots/${s1}/apply`)).json().error).toBe('team:APPLICATIONS_CLOSED')
  })
})

describe('team — the suggested roster, overrides and publishing', () => {
  it('generates from applications, keeps locks, warns without blocking, then publishes', async () => {
    const t = await team(['Aina', 'Amir', 'Sarah'])
    const weekStart = futureMonday()
    const week = await openWeek(t, weekStart, [0, 1, 2, 3, 4, 5].map((day) => ({ day, start: '17:00', end: '22:00' })))
    const slotIds = week.slots.map((slot) => slot.id)
    for (const name of ['Aina', 'Amir', 'Sarah']) {
      for (const slotId of slotIds) await ok(t.staff[name]!.token, 'POST', `/team/slots/${slotId}/apply`)
    }
    await ok(t.b.ownerToken, 'PUT', `/rms/team/staff/${t.staff.Sarah!.id}/attributes`, { soloSuitability: 'NOT_RECOMMENDED', notes: 'SECRET keep off solo' })

    // Management decides Aina must work Saturday, and locks it.
    const saturday = slotIds[5]!
    const assigned = await ok<{ assignmentId: string; warnings: unknown[] }>(t.b.ownerToken, 'POST', `/rms/team/slots/${saturday}/assignments`, {
      staffId: t.staff.Aina!.id,
      isLocked: true,
    })
    expect(assigned.warnings).toEqual([])

    const generated = await ok<WeekDetail>(t.b.ownerToken, 'POST', `/rms/team/weeks/${week.week.id}/generate`)
    expect(generated.week.status).toBe('GENERATED')
    const placed = generated.slots.flatMap((slot) => slot.assignments.filter((a) => a.status === 'ACTIVE').map((a) => ({ slotId: slot.id, ...a })))
    expect(placed).toHaveLength(6)
    expect(placed.find((a) => a.slotId === saturday)).toMatchObject({ staffId: t.staff.Aina!.id, isLocked: true })
    // Balanced: two each, and Sarah is never left alone (every shift is solo).
    const counts = ['Aina', 'Amir'].map((name) => placed.filter((a) => a.staffId === t.staff[name]!.id).length)
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(6)
    expect(placed.filter((a) => a.staffId === t.staff.Sarah!.id)).toHaveLength(0)
    expect(placed.filter((a) => !a.isLocked).every((a) => (a.explanation ?? '').startsWith('Applied for this shift'))).toBe(true)

    // Re-running keeps the lock.
    const again = await ok<WeekDetail>(t.b.ownerToken, 'POST', `/rms/team/weeks/${week.week.id}/generate`)
    expect(again.slots[5]?.assignments.find((a) => a.status === 'ACTIVE')).toMatchObject({ staffId: t.staff.Aina!.id, isLocked: true })

    // Management overrides: puts Sarah on Monday alone. Warned, not stopped.
    const monday = again.slots[0]!
    const mondayAssignment = monday.assignments.find((a) => a.status === 'ACTIVE')!
    await ok(t.b.ownerToken, 'DELETE', `/rms/team/assignments/${mondayAssignment.id}`)
    const override = await ok<{ warnings: Array<{ kind: string }> }>(t.b.ownerToken, 'POST', `/rms/team/slots/${monday.id}/assignments`, { staffId: t.staff.Sarah!.id })
    expect(override.warnings.map((warning) => warning.kind)).toContain('SOLO_NOT_RECOMMENDED')
    const trail = await ok<{ entries: Array<{ action: string }> }>(t.b.ownerToken, 'GET', '/rms/team/audit')
    expect(trail.entries.map((entry) => entry.action)).toContain('roster.assigned_over_warning')

    const published = await ok<WeekDetail>(t.b.ownerToken, 'POST', `/rms/team/weeks/${week.week.id}/publish`)
    expect(published.week.status).toBe('PUBLISHED')
    expect((await call(t.b.ownerToken, 'POST', `/rms/team/weeks/${week.week.id}/generate`)).statusCode).toBe(409)

    // Staff now see confirmed vs not assigned — and nothing confidential.
    const sarahView = await call(t.staff.Sarah!.token, 'GET', '/team/weeks')
    const statuses = (sarahView.json() as { weeks: Array<{ slots: Array<{ myStatus: string }> }> }).weeks[0]!.slots.map((slot) => slot.myStatus)
    expect(statuses[0]).toBe('CONFIRMED')
    expect(statuses.slice(1)).toEqual(['NOT_ASSIGNED', 'NOT_ASSIGNED', 'NOT_ASSIGNED', 'NOT_ASSIGNED', 'NOT_ASSIGNED'])
    for (const url of ['/team/weeks', '/team/home', `/team/weeks/${week.week.id}/roster`]) {
      const response = await call(t.staff.Sarah!.token, 'GET', url)
      expect(response.statusCode, url).toBe(200)
      expect(response.body, url).not.toMatch(CONFIDENTIAL)
    }
    const exported = await call(t.b.ownerToken, 'GET', `/rms/team/weeks/${week.week.id}/export`)
    expect(exported.body).not.toMatch(CONFIDENTIAL)
    expect(exported.json().days[0].shifts[0]).toEqual({ startTime: '17:00', endTime: '22:00', label: null, staff: ['Sarah'] })
  })
})

describe('team — withdrawals and replacements', () => {
  async function publishedWeek(t: Team, applicants: string[]) {
    const weekStart = futureMonday()
    const week = await openWeek(t, weekStart, [{ day: 5, start: '17:00', end: '22:00' }])
    const slotId = week.slots[0]!.id
    for (const name of applicants) await ok(t.staff[name]!.token, 'POST', `/team/slots/${slotId}/apply`)
    await ok(t.b.ownerToken, 'POST', `/rms/team/slots/${slotId}/assignments`, { staffId: t.staff[applicants[0]!]!.id })
    await ok(t.b.ownerToken, 'POST', `/rms/team/weeks/${week.week.id}/publish`)
    return { weekId: week.week.id, slotId }
  }

  it('offers a withdrawn shift to the applicants not picked first, then the next on a no', async () => {
    const t = await team(['Aina', 'Amir', 'Sarah'])
    const { slotId } = await publishedWeek(t, ['Aina', 'Amir'])
    const ainaWeek = await ok<{ weeks: Array<{ slots: Array<{ assignmentId: string; canWithdraw: boolean }> }> }>(t.staff.Aina!.token, 'GET', '/team/weeks')
    const own = ainaWeek.weeks[0]!.slots[0]!
    expect(own.canWithdraw).toBe(true)
    await ok(t.staff.Aina!.token, 'POST', `/team/assignments/${own.assignmentId}/withdraw`)

    // Amir applied and was not picked: he gets the first offer.
    const amirHome = await ok<{ offers: Array<{ id: string }> }>(t.staff.Amir!.token, 'GET', '/team/home')
    expect(amirHome.offers).toHaveLength(1)
    expect((await ok<{ offers: unknown[] }>(t.staff.Sarah!.token, 'GET', '/team/home')).offers).toHaveLength(0)

    await ok(t.staff.Amir!.token, 'POST', `/team/offers/${amirHome.offers[0]!.id}/reject`)
    const sarahHome = await ok<{ offers: Array<{ id: string }> }>(t.staff.Sarah!.token, 'GET', '/team/home')
    expect(sarahHome.offers).toHaveLength(1)
    await ok(t.staff.Sarah!.token, 'POST', `/team/offers/${sarahHome.offers[0]!.id}/accept`)

    const coverage = await ok<{ coverage: Array<{ status: string; offers: Array<{ staffName: string; status: string }> }> }>(t.b.ownerToken, 'GET', '/rms/team/coverage')
    expect(coverage.coverage[0]).toMatchObject({ status: 'FILLED' })
    expect(coverage.coverage[0]!.offers.map((offer) => [offer.staffName, offer.status])).toEqual([
      ['Amir', 'REJECTED'],
      ['Sarah', 'ACCEPTED'],
    ])
    const assignments = await prisma.assignment.findMany({ where: { slotId, status: 'ACTIVE' } })
    expect(assignments.map((assignment) => assignment.staffId)).toEqual([t.staff.Sarah!.id])
    // An offer cannot be taken twice.
    expect((await call(t.staff.Sarah!.token, 'POST', `/team/offers/${sarahHome.offers[0]!.id}/accept`)).statusCode).toBe(409)
  })

  it('records a manager confirming on someone’s behalf, and a skip, as exactly that', async () => {
    const t = await team(['Aina', 'Amir', 'Sarah'])
    const { slotId } = await publishedWeek(t, ['Aina', 'Amir'])
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { slotId, status: 'ACTIVE' } })
    await ok(t.b.ownerToken, 'DELETE', `/rms/team/assignments/${assignment.id}`)

    const coverage = await ok<{ coverage: Array<{ id: string; offers: Array<{ staffName: string }> }> }>(t.b.ownerToken, 'GET', '/rms/team/coverage')
    const request = coverage.coverage[0]!
    expect(request.offers[0]?.staffName).toBe('Amir')
    await ok(t.b.ownerToken, 'POST', `/rms/team/coverage/${request.id}/skip`)
    // Sarah messaged the manager instead.
    await ok(t.b.ownerToken, 'POST', `/rms/team/coverage/${request.id}/confirm`, { staffId: t.staff.Sarah!.id })

    const offers = await prisma.replacementOffer.findMany({ where: { coverageRequestId: request.id }, orderBy: { rank: 'asc' }, include: { staff: true } })
    expect(offers.map((offer) => [offer.staff.name, offer.status])).toEqual([
      ['Amir', 'MANAGER_SKIPPED'],
      ['Sarah', 'MANAGER_CONFIRMED'],
    ])
    const trail = await ok<{ entries: Array<{ action: string }> }>(t.b.ownerToken, 'GET', '/rms/team/audit')
    expect(trail.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['roster.manager_removed', 'coverage.skipped_by_manager', 'coverage.confirmed_by_manager']),
    )
  })

  it('stops staff pulling out after the deadline, and marks late gaps urgent', async () => {
    const t = await team(['Aina', 'Amir'])
    const { slotId, weekId } = await publishedWeek(t, ['Aina', 'Amir'])
    // Move the shift to tomorrow-ish: well inside the 24-hour deadline.
    const soon = new Date(Date.now() + 6 * 3_600_000)
    await prisma.rosterWeek.update({ where: { id: weekId }, data: { withdrawalDeadlineHours: 24 } })
    await prisma.shiftSlot.update({ where: { id: slotId }, data: { startsAt: soon, endsAt: new Date(soon.getTime() + 5 * 3_600_000) } })
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { slotId, status: 'ACTIVE' } })
    const late = await call(t.staff.Aina!.token, 'POST', `/team/assignments/${assignment.id}/withdraw`)
    expect(late.statusCode).toBe(409)
    expect(late.json().error).toBe('team:WITHDRAW_DEADLINE_PASSED')

    // Management can still take them off; the vacancy is urgent.
    await ok(t.b.ownerToken, 'DELETE', `/rms/team/assignments/${assignment.id}`)
    const coverage = await ok<{ coverage: Array<{ isUrgent: boolean }> }>(t.b.ownerToken, 'GET', '/rms/team/coverage')
    expect(coverage.coverage[0]?.isUrgent).toBe(true)
  })
})

describe('team — attendance, payroll and the ledger', () => {
  const period = { start: '2026-09-21', end: '2026-09-27' }

  async function manual(t: Team, staff: string, date: string, start: string, end: string, workTypeId?: string) {
    return ok<{ id: string }>(t.b.ownerToken, 'POST', '/rms/team/attendance', {
      staffId: t.staff[staff]!.id,
      startAt: `${date}T${start}:00+08:00`,
      endAt: `${date}T${end}:00+08:00`,
      ...(workTypeId ? { workTypeId } : {}),
    })
  }

  it('clocks in and out from the app as a claim that management approves', async () => {
    const t = await team(['Aina'])
    const aina = t.staff.Aina!.token
    await ok(aina, 'POST', '/team/attendance/clock-in')
    expect((await call(aina, 'POST', '/team/attendance/clock-in')).statusCode).toBe(409)
    expect((await ok<{ clockedIn: unknown }>(aina, 'GET', '/team/home')).clockedIn).not.toBeNull()
    await ok(aina, 'POST', '/team/attendance/clock-out')

    const today = mytDate(new Date())
    const list = await ok<{ attendance: Array<{ id: string; status: string; flags: string[] }> }>(t.b.ownerToken, 'GET', `/rms/team/attendance?start=${addDays(today, -1)}&end=${addDays(today, 1)}`)
    expect(list.attendance[0]).toMatchObject({ status: 'PENDING' })
    expect(list.attendance[0]!.flags).toContain('UNROSTERED')
    await ok(t.b.ownerToken, 'POST', `/rms/team/attendance/${list.attendance[0]!.id}/approve`, {})
    expect((await ok<{ attendance: Array<{ status: string }> }>(aina, 'GET', '/team/attendance')).attendance[0]?.status).toBe('APPROVED')
  })

  it('pays approved time by work type — the brief’s RM 58.50 — and books it once', async () => {
    const t = await team(['Aina', 'Amir'])
    await manual(t, 'Aina', '2026-09-22', '16:00', '20:00', t.training) // 4h × RM5
    await manual(t, 'Aina', '2026-09-25', '17:00', '22:30') // 5.5h × RM7 (her usual)
    await manual(t, 'Aina', '2026-09-26', '17:00', '22:20') // 5h20 → 5h at half-hour floor

    const summary = await ok<{ rows: Array<{ name: string; status: string; totalSen: number; minutesByType: Record<string, number> }> }>(t.b.ownerToken, 'GET', `/rms/team/payroll?start=${period.start}&end=${period.end}`)
    const aina = summary.rows.find((row) => row.name === 'Aina')!
    expect(aina).toMatchObject({ status: 'DRAFT', totalSen: 2000 + 3850 + 3500, minutesByType: { Training: 240, Regular: 630 } })

    const approved = await ok<{ payslipId: string; totalSen: number }>(t.b.ownerToken, 'POST', '/rms/team/payroll/approve', { staffId: t.staff.Aina!.id, ...period })
    expect(approved.totalSen).toBe(9350)

    const first = await ok<{ replayed: boolean; ledgerEntryId: string }>(t.b.ownerToken, 'POST', `/rms/team/payslips/${approved.payslipId}/pay`, {})
    const second = await ok<{ replayed: boolean; ledgerEntryId: string }>(t.b.ownerToken, 'POST', `/rms/team/payslips/${approved.payslipId}/pay`, {})
    expect(first.replayed).toBe(false)
    expect(second).toEqual({ ...first, replayed: true })

    const ledger = await prisma.ledgerEntry.findMany({ where: { businessId: t.b.businessId } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ direction: 'MONEY_OUT', amountSen: 9350, category: 'OPERATING_EXPENSE', description: 'Aina — Payroll 21–27 Sept' })
    const expense = await prisma.expense.findFirstOrThrow({ where: { businessId: t.b.businessId } })
    expect(expense).toMatchObject({ category: 'WAGES', amountSen: 9350, paidBy: 'STALL_FUNDS' })

    // Her own pay is visible to her; Amir sees none of it.
    const own = await call(t.staff.Aina!.token, 'GET', '/team/pay')
    expect(own.json().payslips[0]).toMatchObject({ status: 'PAID', totalSen: 9350 })
    const other = await call(t.staff.Amir!.token, 'GET', '/team/pay')
    expect(other.json().payslips).toEqual([])
    expect(other.body).not.toContain('9350')
  })

  it('never rewrites a paid payslip: a later attendance change becomes an adjustment', async () => {
    const t = await team(['Aina'])
    const record = await manual(t, 'Aina', '2026-09-25', '17:00', '22:00') // 5h × RM7 = 3500
    const { payslipId } = await ok<{ payslipId: string }>(t.b.ownerToken, 'POST', '/rms/team/payroll/approve', { staffId: t.staff.Aina!.id, ...period })
    await ok(t.b.ownerToken, 'POST', `/rms/team/payslips/${payslipId}/pay`, {})

    // She actually stayed an hour later.
    await ok(t.b.ownerToken, 'PATCH', `/rms/team/attendance/${record.id}`, { approvedEndAt: '2026-09-25T23:00:00+08:00' })

    const paid = await prisma.payslip.findUniqueOrThrow({ where: { id: payslipId }, include: { lines: true } })
    expect(paid).toMatchObject({ status: 'PAID', totalSen: 3500 })
    const adjustments = await ok<{ adjustments: Array<{ amountSen: number; status: string; reason: string }> }>(t.b.ownerToken, 'GET', '/rms/team/adjustments')
    expect(adjustments.adjustments).toHaveLength(1)
    expect(adjustments.adjustments[0]).toMatchObject({ amountSen: 700, status: 'OPEN' })
    expect(adjustments.adjustments[0]!.reason).toMatch(/RM 7\.00 more may be owed/)

    // The database itself refuses to touch the paid record.
    await expect(prisma.payslip.update({ where: { id: payslipId }, data: { totalSen: 1 } })).rejects.toThrow()
    await expect(prisma.payslipLine.deleteMany({ where: { payslipId } })).rejects.toThrow()

    // The next payslip carries the RM 7 as its own line.
    const next = { start: '2026-09-28', end: '2026-10-04' }
    const detail = await ok<{ lines: Array<{ kind: string; amountSen: number }>; totalSen: number }>(t.b.ownerToken, 'GET', `/rms/team/payroll/staff/${t.staff.Aina!.id}?start=${next.start}&end=${next.end}`)
    expect(detail.lines).toEqual([expect.objectContaining({ kind: 'ADJUSTMENT', amountSen: 700 })])
    await ok(t.b.ownerToken, 'POST', '/rms/team/payroll/approve', { staffId: t.staff.Aina!.id, ...next })
    expect((await ok<{ adjustments: Array<{ status: string }> }>(t.b.ownerToken, 'GET', '/rms/team/adjustments')).adjustments[0]?.status).toBe('INCLUDED')
  })

  it('sends an approved, unpaid payslip back to draft when its attendance changes', async () => {
    const t = await team(['Aina'])
    const record = await manual(t, 'Aina', '2026-09-25', '17:00', '22:00')
    await ok(t.b.ownerToken, 'POST', '/rms/team/payroll/approve', { staffId: t.staff.Aina!.id, ...period })
    await ok(t.b.ownerToken, 'PATCH', `/rms/team/attendance/${record.id}`, { approvedEndAt: '2026-09-25T21:00:00+08:00' })
    const summary = await ok<{ rows: Array<{ status: string; totalSen: number }> }>(t.b.ownerToken, 'GET', `/rms/team/payroll?start=${period.start}&end=${period.end}`)
    expect(summary.rows[0]).toMatchObject({ status: 'DRAFT', totalSen: 2800 })
  })

  it('pays a one-off rate on a shift without touching the work type', async () => {
    const t = await team(['Aina'])
    const weekStart = '2026-09-21'
    const week = await ok<WeekDetail>(t.b.ownerToken, 'POST', '/rms/team/weeks', { weekStart, fromTemplate: false })
    const withSlot = await ok<WeekDetail>(t.b.ownerToken, 'POST', `/rms/team/weeks/${week.week.id}/slots`, { date: '2026-09-26', startTime: '17:00', endTime: '22:00' })
    const slotId = withSlot.slots[0]!.id
    const { assignmentId } = await ok<{ assignmentId: string }>(t.b.ownerToken, 'POST', `/rms/team/slots/${slotId}/assignments`, { staffId: t.staff.Aina!.id })
    await ok(t.b.ownerToken, 'PATCH', `/rms/team/assignments/${assignmentId}`, { rateOverrideSen: 1200, rateOverrideReason: 'Event night' })
    await ok(t.b.ownerToken, 'POST', '/rms/team/attendance', {
      staffId: t.staff.Aina!.id,
      assignmentId,
      startAt: '2026-09-26T17:00:00+08:00',
      endAt: '2026-09-26T22:00:00+08:00',
    })
    const detail = await ok<{ lines: Array<{ workTypeName: string; rateSenPerHour: number; amountSen: number }> }>(t.b.ownerToken, 'GET', `/rms/team/payroll/staff/${t.staff.Aina!.id}?start=${period.start}&end=${period.end}`)
    expect(detail.lines[0]).toMatchObject({ workTypeName: 'Regular (special rate)', rateSenPerHour: 1200, amountSen: 6000 })
    const workTypes = await ok<{ workTypes: Array<{ name: string; rateSenPerHour: number }> }>(t.b.ownerToken, 'GET', '/rms/team/work-types')
    expect(workTypes.workTypes.find((type) => type.name === 'Regular')?.rateSenPerHour).toBe(700)
    const trail = await ok<{ entries: Array<{ action: string }> }>(t.b.ownerToken, 'GET', '/rms/team/audit')
    expect(trail.entries.map((entry) => entry.action)).toContain('pay.rate_overridden')
  })
})
