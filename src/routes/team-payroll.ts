import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.ts'
import type { Tx } from '../db.ts'
import { businessToday } from '../domain/business-date.ts'
import { addDays, ISO_DATE, minutesBetween, mytDate, mytTime, rangeLabel } from '../domain/team-time.ts'
import { payableMinutes, recentPeriods } from '../domain/payroll.ts'
import { splitShared } from '../domain/settlement.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { actorOf, audit } from '../team/audit.ts'
import {
  attendanceChanged,
  dateRange,
  draftFor,
  loadAttendanceForPay,
  rateFor,
  revertPayslip,
  roundingFor,
  type DraftLine,
} from '../team/payroll-data.ts'
import { teamSettingsFor } from './team-rms.ts'

/**
 * Team, management side: attendance review and payroll.
 *
 * Roster is what was planned, attendance is what happened, and payroll pays
 * only approved attendance. Paying writes a Wages expense and its ledger line
 * in the same transaction as the payslip turning paid, guarded so a second
 * click finds nothing left to pay.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(ISO_DATE)
const INSTANT = z.string().datetime({ offset: true })

const rangeQuery = z.object({ start: DATE, end: DATE })
const attendanceQuery = z.object({
  start: DATE,
  end: DATE,
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  staffId: ID.optional(),
})
const manualBody = z.object({
  staffId: ID,
  startAt: INSTANT,
  endAt: INSTANT,
  assignmentId: ID.nullish(),
  workTypeId: ID.nullish(),
  note: z.string().trim().max(300).nullish(),
})
const editBody = z
  .object({
    approvedStartAt: INSTANT,
    approvedEndAt: INSTANT,
    clockOutAt: INSTANT,
    workTypeId: ID.nullable(),
    assignmentId: ID.nullable(),
    note: z.string().trim().max(300).nullable(),
  })
  .partial()
const approveBody = z.object({ approvedStartAt: INSTANT.optional(), approvedEndAt: INSTANT.optional() })
const rejectBody = z.object({ note: z.string().trim().max(300).nullish() })
const fromRosterBody = z.object({ assignmentIds: z.array(ID).min(1).max(500) })
const payslipApprove = z.object({ staffId: ID, start: DATE, end: DATE })
const payBody = z.object({ paidOn: DATE.optional() })
const dismissBody = z.object({ note: z.string().trim().min(1).max(300) })

const toDate = (value: string) => new Date(`${value}T00:00:00Z`)

function hoursByType(lines: Array<{ workTypeName: string; minutes: number; kind: string }>) {
  const byType: Record<string, number> = {}
  for (const line of lines) {
    if (line.kind !== 'ATTENDANCE') continue
    const key = line.workTypeName.replace(/ \(special rate\)$/, '')
    byType[key] = (byType[key] ?? 0) + line.minutes
  }
  return byType
}

function serialiseStoredLine(line: {
  kind: string
  attendanceId: string | null
  adjustmentId: string | null
  workDate: Date
  clockInAt: Date | null
  clockOutAt: Date | null
  minutes: number
  workTypeName: string
  rateSenPerHour: number
  amountSen: number
  description: string | null
}) {
  return {
    kind: line.kind,
    attendanceId: line.attendanceId,
    adjustmentId: line.adjustmentId,
    workDate: line.workDate.toISOString().slice(0, 10),
    clockInAt: line.clockInAt?.toISOString() ?? null,
    clockOutAt: line.clockOutAt?.toISOString() ?? null,
    minutes: line.minutes,
    workTypeName: line.workTypeName,
    rateSenPerHour: line.rateSenPerHour,
    amountSen: line.amountSen,
    description: line.description,
  }
}

async function assertNotLocked(tx: Tx, date: string): Promise<void> {
  const closure = await tx.periodClosure.findFirst({ where: { startDate: { lte: toDate(date) }, endDate: { gte: toDate(date) } } })
  if (closure) throw conflict('rms:PERIOD_LOCKED')
}

export async function teamPayrollRoutes(app: FastifyInstance): Promise<void> {
  const review = { preHandler: requirePermission('attendance.review') }
  const process = { preHandler: requirePermission('payroll.process') }
  const pay = { preHandler: requirePermission('payroll.pay') }

  // -------------------------------------------------------------------------
  // Attendance
  // -------------------------------------------------------------------------

  app.get('/rms/team/attendance', review, async (request) => {
    const query = attendanceQuery.parse(request.query)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      const rounding = await roundingFor(tx, businessId)
      const records = await loadAttendanceForPay(tx, {
        clockInAt: dateRange(query.start, query.end),
        ...(query.status ? { status: query.status } : {}),
        ...(query.staffId ? { staffId: query.staffId } : {}),
      })
      const onPayslips = await tx.payslipLine.findMany({
        where: { attendanceId: { in: records.map((record) => record.id) }, kind: 'ATTENDANCE' },
        select: { attendanceId: true, payslip: { select: { status: true } } },
      })
      const payslipStatus = new Map(onPayslips.map((line) => [line.attendanceId, line.payslip.status]))
      return {
        attendance: records.map((record) => {
          const start = record.approvedStartAt ?? record.clockInAt
          const end = record.approvedEndAt ?? record.clockOutAt
          const rate = rateFor(record)
          return {
            id: record.id,
            staffId: record.staffId,
            staffName: record.staff.name,
            status: record.status,
            source: record.source,
            date: mytDate(record.clockInAt),
            clockInAt: record.clockInAt.toISOString(),
            clockOutAt: record.clockOutAt?.toISOString() ?? null,
            approvedStartAt: record.approvedStartAt?.toISOString() ?? null,
            approvedEndAt: record.approvedEndAt?.toISOString() ?? null,
            shift: record.assignment
              ? {
                  startTime: mytTime(record.assignment.slot.startsAt),
                  endTime: mytTime(record.assignment.slot.endsAt),
                  label: record.assignment.slot.label,
                }
              : null,
            assignmentId: record.assignmentId,
            workTypeId: record.workTypeId,
            note: record.note,
            payableMinutes: end ? payableMinutes(start, end, rounding) : null,
            workedMinutes: end ? minutesBetween(start, end) : null,
            rate: rate ? { workTypeName: rate.workTypeName, rateSenPerHour: rate.rateSenPerHour } : null,
            payslipStatus: payslipStatus.get(record.id) ?? null,
            flags: [
              ...(record.clockOutAt ? [] : ['NO_CLOCK_OUT']),
              ...(record.assignmentId ? [] : ['UNROSTERED']),
              ...(rate ? [] : ['NO_RATE']),
            ],
          }
        }),
      }
    })
  })

  /**
   * Shifts that have finished on a published roster and that nobody has
   * confirmed yet — with no clock-in, this is where hours come from: management
   * confirms each as worked (adjusting times if someone left early).
   */
  app.get('/rms/team/attendance/unconfirmed', review, async (request) => {
    const { start, end } = rangeQuery.parse(request.query)
    const range = dateRange(start, end)
    const now = new Date()
    const assignments = await request.db.assignment.findMany({
      where: {
        status: 'ACTIVE',
        attendance: { none: { status: { not: 'REJECTED' } } },
        slot: {
          rosterWeek: { status: 'PUBLISHED' },
          startsAt: { gte: range.gte, lt: range.lt },
          endsAt: { lte: now },
        },
      },
      include: { staff: { select: { name: true } }, slot: true },
      orderBy: [{ slot: { startsAt: 'asc' } }, { staff: { name: 'asc' } }],
    })
    return {
      shifts: assignments.map((assignment) => ({
        assignmentId: assignment.id,
        staffId: assignment.staffId,
        staffName: assignment.staff.name,
        date: mytDate(assignment.slot.startsAt),
        startTime: mytTime(assignment.slot.startsAt),
        endTime: mytTime(assignment.slot.endsAt),
        startsAt: assignment.slot.startsAt.toISOString(),
        endsAt: assignment.slot.endsAt.toISOString(),
        minutes: minutesBetween(assignment.slot.startsAt, assignment.slot.endsAt),
        label: assignment.slot.label,
      })),
    }
  })

  /** Confirm rostered shifts as worked, at their rostered times. Approved at once. */
  app.post('/rms/team/attendance/from-roster', review, async (request) => {
    const { assignmentIds } = fromRosterBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const created = await db.$transaction(async (tx) => {
      const assignments = await tx.assignment.findMany({
        where: { id: { in: assignmentIds }, status: 'ACTIVE' },
        include: { slot: true, attendance: { where: { status: { not: 'REJECTED' } }, select: { id: true } } },
      })
      let count = 0
      for (const assignment of assignments) {
        // Already confirmed (a double tap, or two managers): leave it.
        if (assignment.attendance.length > 0) continue
        const record = await tx.attendanceRecord.create({
          data: {
            businessId,
            staffId: assignment.staffId,
            assignmentId: assignment.id,
            clockInAt: assignment.slot.startsAt,
            clockOutAt: assignment.slot.endsAt,
            approvedStartAt: assignment.slot.startsAt,
            approvedEndAt: assignment.slot.endsAt,
            source: 'MANUAL',
            status: 'APPROVED',
            approvedAt: new Date(),
            note: 'Worked as rostered',
          },
        })
        await audit(tx, businessId, actor, {
          action: 'attendance.confirmed_from_roster',
          entityType: 'attendance',
          entityId: record.id,
          after: { assignmentId: assignment.id, staffId: assignment.staffId },
        })
        count += 1
      }
      return count
    })
    return { confirmed: created }
  })

  /** Time management records by hand. Approved as it is entered. */
  app.post('/rms/team/attendance', review, async (request) => {
    const body = manualBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const start = new Date(body.startAt)
    const end = new Date(body.endAt)
    if (end <= start) throw badRequest('team:TIMES_BACKWARDS')
    const record = await db.$transaction(async (tx) => {
      if (!(await tx.staffMember.findUnique({ where: { id: body.staffId } }))) throw notFound('team:STAFF_NOT_FOUND')
      if (body.assignmentId) {
        const assignment = await tx.assignment.findUnique({ where: { id: body.assignmentId } })
        if (!assignment || assignment.staffId !== body.staffId) throw badRequest('team:ASSIGNMENT_NOT_FOUND')
      }
      if (body.workTypeId && !(await tx.workType.findUnique({ where: { id: body.workTypeId } }))) {
        throw badRequest('team:WORK_TYPE_NOT_FOUND')
      }
      const created = await tx.attendanceRecord.create({
        data: {
          businessId,
          staffId: body.staffId,
          assignmentId: body.assignmentId ?? null,
          clockInAt: start,
          clockOutAt: end,
          approvedStartAt: start,
          approvedEndAt: end,
          workTypeId: body.workTypeId ?? null,
          note: body.note ?? null,
          source: 'MANUAL',
          status: 'APPROVED',
          approvedAt: new Date(),
        },
      })
      await audit(tx, businessId, actor, { action: 'attendance.added_manually', entityType: 'attendance', entityId: created.id, after: body })
      return created
    })
    return { id: record.id }
  })

  /**
   * Edit times, work type or link. A record already on an approved payslip
   * sends that payslip back to draft; one on a paid payslip leaves the paid
   * amount alone and flags the difference as an adjustment.
   */
  app.patch<{ Params: { id: string } }>('/rms/team/attendance/:id', review, async (request) => {
    const id = ID.parse(request.params.id)
    const body = editBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const before = await tx.attendanceRecord.findUnique({ where: { id } })
      if (!before) throw notFound('team:ATTENDANCE_NOT_FOUND')
      const start = body.approvedStartAt ? new Date(body.approvedStartAt) : (before.approvedStartAt ?? before.clockInAt)
      const end = body.approvedEndAt ? new Date(body.approvedEndAt) : (before.approvedEndAt ?? (body.clockOutAt ? new Date(body.clockOutAt) : before.clockOutAt))
      if (end && end <= start) throw badRequest('team:TIMES_BACKWARDS')
      if (body.clockOutAt && new Date(body.clockOutAt) <= before.clockInAt) throw badRequest('team:TIMES_BACKWARDS')
      if (body.workTypeId && !(await tx.workType.findUnique({ where: { id: body.workTypeId } }))) {
        throw badRequest('team:WORK_TYPE_NOT_FOUND')
      }
      const after = await tx.attendanceRecord.update({
        where: { id },
        data: {
          ...(body.approvedStartAt ? { approvedStartAt: new Date(body.approvedStartAt) } : {}),
          ...(body.approvedEndAt ? { approvedEndAt: new Date(body.approvedEndAt) } : {}),
          ...(body.clockOutAt ? { clockOutAt: new Date(body.clockOutAt) } : {}),
          ...(body.workTypeId !== undefined ? { workTypeId: body.workTypeId } : {}),
          ...(body.assignmentId !== undefined ? { assignmentId: body.assignmentId } : {}),
          ...(body.note !== undefined ? { note: body.note } : {}),
          version: { increment: 1 },
        },
      })
      await audit(tx, businessId, actor, {
        action: 'attendance.edited',
        entityType: 'attendance',
        entityId: id,
        before: { approvedStartAt: before.approvedStartAt, approvedEndAt: before.approvedEndAt, clockOutAt: before.clockOutAt, workTypeId: before.workTypeId },
        after: { approvedStartAt: after.approvedStartAt, approvedEndAt: after.approvedEndAt, clockOutAt: after.clockOutAt, workTypeId: after.workTypeId },
      })
      await attendanceChanged(tx, businessId, actor, id)
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/rms/team/attendance/:id/approve', review, async (request) => {
    const id = ID.parse(request.params.id)
    const body = approveBody.parse(request.body ?? {})
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const before = await tx.attendanceRecord.findUnique({ where: { id } })
      if (!before) throw notFound('team:ATTENDANCE_NOT_FOUND')
      const start = body.approvedStartAt ? new Date(body.approvedStartAt) : (before.approvedStartAt ?? before.clockInAt)
      const end = body.approvedEndAt ? new Date(body.approvedEndAt) : (before.approvedEndAt ?? before.clockOutAt)
      if (!end) throw badRequest('team:NO_CLOCK_OUT')
      if (end <= start) throw badRequest('team:TIMES_BACKWARDS')
      await tx.attendanceRecord.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedStartAt: start,
          approvedEndAt: end,
          approvedAt: new Date(),
          clockOutAt: before.clockOutAt ?? end,
          version: { increment: 1 },
        },
      })
      await audit(tx, businessId, actor, {
        action: 'attendance.approved',
        entityType: 'attendance',
        entityId: id,
        before: { status: before.status },
        after: { approvedStartAt: start, approvedEndAt: end },
      })
      if (before.status === 'APPROVED') await attendanceChanged(tx, businessId, actor, id)
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/rms/team/attendance/:id/reject', review, async (request) => {
    const id = ID.parse(request.params.id)
    const body = rejectBody.parse(request.body ?? {})
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const before = await tx.attendanceRecord.findUnique({ where: { id } })
      if (!before) throw notFound('team:ATTENDANCE_NOT_FOUND')
      await tx.attendanceRecord.update({
        where: { id },
        data: {
          status: 'REJECTED',
          // A rejected open clock-in is closed off so the person can clock in again.
          clockOutAt: before.clockOutAt ?? new Date(Math.max(Date.now(), before.clockInAt.getTime() + 60_000)),
          note: body.note ?? before.note,
          version: { increment: 1 },
        },
      })
      await audit(tx, businessId, actor, { action: 'attendance.rejected', entityType: 'attendance', entityId: id, before: { status: before.status }, after: { note: body.note ?? null } })
      if (before.status === 'APPROVED') await attendanceChanged(tx, businessId, actor, id)
    })
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Payroll
  // -------------------------------------------------------------------------

  app.get('/rms/team/payroll/periods', process, async (request) => {
    const { db, businessId } = request
    const settings = await teamSettingsFor(db, businessId)
    const today = await businessToday(db, businessId)
    const anchor = settings.payAnchorDate.toISOString().slice(0, 10)
    const periods = recentPeriods(today, settings.payFrequency, anchor, 8).map((period) => ({
      start: period.start,
      end: period.end,
      label: rangeLabel(period.start, period.end),
      payday: addDays(period.end, settings.paydayOffsetDays),
    }))
    return { frequency: settings.payFrequency, today, periods }
  })

  /** One line per staff member for a period: hours by work type, amount, status. */
  app.get('/rms/team/payroll', process, async (request) => {
    const { start, end } = rangeQuery.parse(request.query)
    if (end < start) throw badRequest('team:RANGE_BACKWARDS')
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      const range = dateRange(start, end)
      const [withAttendance, payslips, withAdjustments] = await Promise.all([
        tx.attendanceRecord.findMany({ where: { clockInAt: range, status: { in: ['APPROVED', 'PENDING'] } }, select: { staffId: true }, distinct: ['staffId'] }),
        tx.payslip.findMany({ where: { periodStart: toDate(start), periodEnd: toDate(end) }, include: { lines: true } }),
        tx.payrollAdjustment.findMany({ where: { status: 'OPEN' }, select: { staffId: true }, distinct: ['staffId'] }),
      ])
      const staffIds = [...new Set([...withAttendance, ...payslips, ...withAdjustments].map((row) => row.staffId))]
      const staff = await tx.staffMember.findMany({ where: { id: { in: staffIds } }, orderBy: { name: 'asc' }, select: { id: true, name: true, staffCode: true } })

      const rows = []
      for (const member of staff) {
        const stored = payslips.find((payslip) => payslip.staffId === member.id)
        const draft = await draftFor(tx, businessId, member.id, start, end)
        if (stored) {
          rows.push({
            staffId: member.id,
            name: member.name,
            staffCode: member.staffCode,
            status: stored.status,
            payslipId: stored.id,
            minutesByType: hoursByType(stored.lines),
            totalMinutes: stored.totalMinutes,
            totalSen: stored.totalSen,
            paidAt: stored.paidAt?.toISOString() ?? null,
            // Approved later, after this payslip: worth knowing before paying.
            unpaidAfterPayslipSen: draft.lines.filter((line) => line.kind === 'ATTENDANCE').reduce((sum, line) => sum + line.amountSen, 0),
            pendingCount: draft.pendingCount,
            openAdjustments: draft.lines.filter((line) => line.kind === 'ADJUSTMENT').length,
            problems: [],
          })
          continue
        }
        if (draft.lines.length === 0 && draft.pendingCount === 0 && draft.missingEnd.length === 0 && draft.missingRate.length === 0) continue
        rows.push({
          staffId: member.id,
          name: member.name,
          staffCode: member.staffCode,
          status: 'DRAFT',
          payslipId: null,
          minutesByType: hoursByType(draft.lines),
          totalMinutes: draft.lines.filter((line) => line.kind === 'ATTENDANCE').reduce((sum, line) => sum + line.minutes, 0),
          totalSen: draft.lines.reduce((sum, line) => sum + line.amountSen, 0),
          paidAt: null,
          unpaidAfterPayslipSen: 0,
          pendingCount: draft.pendingCount,
          openAdjustments: draft.lines.filter((line) => line.kind === 'ADJUSTMENT').length,
          problems: [
            ...draft.missingRate.map((item) => `No work type or rate for ${item.date}.`),
            ...draft.missingEnd.map((item) => `No end time on ${item.date}.`),
          ],
        })
      }
      return { start, end, label: rangeLabel(start, end), rows }
    })
  })

  /** One staff member's payslip for a period, line by line. */
  app.get<{ Params: { staffId: string } }>('/rms/team/payroll/staff/:staffId', process, async (request) => {
    const staffId = ID.parse(request.params.staffId)
    const { start, end } = rangeQuery.parse(request.query)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      const staff = await tx.staffMember.findUnique({ where: { id: staffId }, select: { id: true, name: true, staffCode: true } })
      if (!staff) throw notFound('team:STAFF_NOT_FOUND')
      const stored = await tx.payslip.findFirst({
        where: { staffId, periodStart: toDate(start), periodEnd: toDate(end) },
        include: { lines: { orderBy: [{ sortOrder: 'asc' }] } },
      })
      if (stored) {
        return {
          staff,
          start,
          end,
          status: stored.status,
          payslipId: stored.id,
          lines: stored.lines.map(serialiseStoredLine),
          totalMinutes: stored.totalMinutes,
          totalSen: stored.totalSen,
          approvedAt: stored.approvedAt.toISOString(),
          paidAt: stored.paidAt?.toISOString() ?? null,
          paidOn: stored.paidOn?.toISOString().slice(0, 10) ?? null,
          expenseId: stored.expenseId,
          problems: [],
          pendingCount: 0,
        }
      }
      const draft = await draftFor(tx, businessId, staffId, start, end)
      return {
        staff,
        start,
        end,
        status: 'DRAFT',
        payslipId: null,
        lines: draft.lines,
        totalMinutes: draft.lines.filter((line) => line.kind === 'ATTENDANCE').reduce((sum, line) => sum + line.minutes, 0),
        totalSen: draft.lines.reduce((sum, line) => sum + line.amountSen, 0),
        approvedAt: null,
        paidAt: null,
        paidOn: null,
        expenseId: null,
        problems: [
          ...draft.missingRate.map((item) => `No work type or rate for ${item.date}.`),
          ...draft.missingEnd.map((item) => `No end time on ${item.date}.`),
        ],
        pendingCount: draft.pendingCount,
      }
    })
  })

  /** Snapshot a draft into an approved payslip. Not final until paid. */
  app.post('/rms/team/payroll/approve', process, async (request) => {
    const body = payslipApprove.parse(request.body)
    if (body.end < body.start) throw badRequest('team:RANGE_BACKWARDS')
    const { db, businessId } = request
    const actor = await actorOf(request)
    const payslip = await db.$transaction(async (tx) => {
      if (await tx.payslip.findFirst({ where: { staffId: body.staffId, periodStart: toDate(body.start), periodEnd: toDate(body.end) } })) {
        throw conflict('team:PAYSLIP_EXISTS')
      }
      const draft = await draftFor(tx, businessId, body.staffId, body.start, body.end)
      if (draft.missingRate.length > 0) throw badRequest('team:NO_RATE')
      if (draft.lines.length === 0) throw badRequest('team:NOTHING_TO_PAY')
      const lines: DraftLine[] = draft.lines
      const created = await tx.payslip.create({
        data: {
          businessId,
          staffId: body.staffId,
          periodStart: toDate(body.start),
          periodEnd: toDate(body.end),
          status: 'APPROVED',
          totalMinutes: lines.filter((line) => line.kind === 'ATTENDANCE').reduce((sum, line) => sum + line.minutes, 0),
          totalSen: lines.reduce((sum, line) => sum + line.amountSen, 0),
          lines: {
            // Nested through the composite key, so a line can only ever belong
            // to a payslip of the same business.
            create: lines.map((line, index) => ({
              kind: line.kind,
              attendanceId: line.attendanceId,
              attendanceVersion: line.attendanceVersion,
              adjustmentId: line.adjustmentId,
              workDate: toDate(line.workDate),
              clockInAt: line.approvedStartAt ? new Date(line.approvedStartAt) : null,
              clockOutAt: line.approvedEndAt ? new Date(line.approvedEndAt) : null,
              minutes: line.minutes,
              workTypeName: line.workTypeName,
              rateSenPerHour: line.rateSenPerHour,
              amountSen: line.amountSen,
              description: line.description,
              sortOrder: index,
            })),
          },
        },
      })
      const adjustmentIds = lines.flatMap((line) => (line.adjustmentId ? [line.adjustmentId] : []))
      if (adjustmentIds.length > 0) {
        await tx.payrollAdjustment.updateMany({
          where: { id: { in: adjustmentIds }, status: 'OPEN' },
          data: { status: 'INCLUDED', includedInPayslipId: created.id, resolvedAt: new Date() },
        })
      }
      await audit(tx, businessId, actor, {
        action: 'payroll.approved',
        entityType: 'payslip',
        entityId: created.id,
        after: { staffId: body.staffId, start: body.start, end: body.end, totalSen: created.totalSen, lines: lines.length },
      })
      return created
    })
    return { payslipId: payslip.id, totalSen: payslip.totalSen }
  })

  app.post<{ Params: { id: string } }>('/rms/team/payslips/:id/unapprove', process, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const payslip = await tx.payslip.findUnique({ where: { id } })
      if (!payslip) throw notFound('team:PAYSLIP_NOT_FOUND')
      if (payslip.status === 'PAID') throw conflict('team:PAYSLIP_PAID')
      await revertPayslip(tx, businessId, actor, id, 'payroll.unapproved')
    })
    return { ok: true }
  })

  /**
   * Mark a payslip paid. One transaction: a Wages expense (shared, split like
   * rent when partner settlement is on), its ledger line, and the payslip
   * turning paid — guarded on its status, so a double tap or two managers at
   * once pay it exactly once and the second gets the first's result.
   */
  app.post<{ Params: { id: string } }>('/rms/team/payslips/:id/pay', pay, async (request) => {
    const id = ID.parse(request.params.id)
    const body = payBody.parse(request.body ?? {})
    const { db, businessId } = request
    const actor = await actorOf(request)

    const result = await db.$transaction(async (tx) => {
      const payslip = await tx.payslip.findUnique({ where: { id }, include: { staff: { select: { name: true } } } })
      if (!payslip) throw notFound('team:PAYSLIP_NOT_FOUND')
      if (payslip.status === 'PAID') {
        return { replayed: true, expenseId: payslip.expenseId, ledgerEntryId: payslip.ledgerEntryId?.toString() ?? null }
      }
      const paidOn = body.paidOn ?? (await businessToday(tx, businessId))
      await assertNotLocked(tx, paidOn)

      // Taken first, so a concurrent payment of the same payslip waits here and
      // then finds it already paid.
      await tx.$queryRaw`SELECT id FROM payslips WHERE id = ${id} AND business_id = ${businessId} FOR UPDATE`
      const locked = await tx.payslip.findUniqueOrThrow({ where: { id } })
      if (locked.status === 'PAID') {
        return { replayed: true, expenseId: locked.expenseId, ledgerEntryId: locked.ledgerEntryId?.toString() ?? null }
      }

      const settings = await tx.accountSettings.findUnique({ where: { businessId } })
      const withSettlement = settings?.settlementEnabled ?? false
      const foodPct = withSettlement ? (settings?.sharedOverheadFoodPct ?? 100) : 100
      const { foodSen, drinksSen } = withSettlement
        ? splitShared(payslip.totalSen, foodPct)
        : { foodSen: payslip.totalSen, drinksSen: 0 }
      const description = `${payslip.staff.name} — Payroll ${rangeLabel(
        payslip.periodStart.toISOString().slice(0, 10),
        payslip.periodEnd.toISOString().slice(0, 10),
      )}`

      const expense = await tx.expense.create({
        data: {
          businessId,
          businessDate: toDate(paidOn),
          amountSen: payslip.totalSen,
          category: 'WAGES',
          paidBy: 'STALL_FUNDS',
          brandId: null,
          foodSplitPct: foodPct,
          foodAmountSen: foodSen,
          drinksAmountSen: drinksSen,
          description,
          notes: `Payslip ${payslip.id}`,
          isSettled: true,
          createdById: request.user.id,
        },
      })
      const ledger = await tx.ledgerEntry.create({
        data: {
          businessId,
          businessDate: toDate(paidOn),
          direction: 'MONEY_OUT',
          amountSen: payslip.totalSen,
          category: 'OPERATING_EXPENSE',
          description,
          brandId: null,
        },
      })
      const paid = await tx.payslip.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'PAID', paidAt: new Date(), paidOn: toDate(paidOn), expenseId: expense.id, ledgerEntryId: ledger.id },
      })
      if (paid.count !== 1) throw conflict('team:PAYSLIP_CHANGED')
      await audit(tx, businessId, actor, {
        action: 'payroll.paid',
        entityType: 'payslip',
        entityId: id,
        after: { totalSen: payslip.totalSen, paidOn, expenseId: expense.id, ledgerEntryId: ledger.id.toString() },
      })
      await audit(tx, businessId, actor, {
        action: 'ledger.wages_entry_created',
        entityType: 'ledger_entry',
        entityId: ledger.id.toString(),
        after: { description, amountSen: payslip.totalSen, payslipId: id, staffId: payslip.staffId },
      })
      return { replayed: false, expenseId: expense.id, ledgerEntryId: ledger.id.toString() }
    })
    return result
  })

  // -------------------------------------------------------------------------
  // Adjustments from changes after payment
  // -------------------------------------------------------------------------

  app.get('/rms/team/adjustments', process, async (request) => {
    const rows = await request.db.payrollAdjustment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { staff: { select: { name: true } } },
    })
    return {
      adjustments: rows.map((row) => ({
        id: row.id,
        staffId: row.staffId,
        staffName: row.staff.name,
        amountSen: row.amountSen,
        minutesDelta: row.minutesDelta,
        reason: row.reason,
        status: row.status,
        causePayslipId: row.causePayslipId,
        includedInPayslipId: row.includedInPayslipId,
        resolvedNote: row.resolvedNote,
        createdAt: row.createdAt.toISOString(),
      })),
    }
  })

  app.post<{ Params: { id: string } }>('/rms/team/adjustments/:id/dismiss', process, async (request) => {
    const id = ID.parse(request.params.id)
    const { note } = dismissBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const done = await tx.payrollAdjustment.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'DISMISSED', resolvedNote: note, resolvedAt: new Date() },
      })
      if (done.count === 0) throw conflict('team:ADJUSTMENT_CLOSED')
      await audit(tx, businessId, actor, { action: 'payroll.adjustment_dismissed', entityType: 'payroll_adjustment', entityId: id, after: { note } })
    })
    return { ok: true }
  })
}
