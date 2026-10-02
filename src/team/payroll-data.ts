import type { Tx } from '../db.ts'
import { lineAmountSen, payableMinutes, resolveRate, type ResolvedRate, type Rounding } from '../domain/payroll.ts'
import { mytDate } from '../domain/team-time.ts'
import { audit, type Actor } from './audit.ts'

/**
 * Payroll as the business works it: approved attendance → a draft worked out
 * live → approved (lines snapshotted) → paid (frozen; the database refuses any
 * later change). A draft is never stored, so it can never go stale.
 */

const WORK_TYPE = { select: { name: true, rateSenPerHour: true } } as const

export const ATTENDANCE_FOR_PAY = {
  workType: WORK_TYPE,
  staff: { select: { id: true, name: true, defaultWorkType: WORK_TYPE } },
  assignment: {
    select: {
      rateOverrideSen: true,
      workType: WORK_TYPE,
      slot: { select: { startsAt: true, endsAt: true, label: true, workType: WORK_TYPE } },
    },
  },
} as const

type AttendanceForPay = Awaited<ReturnType<typeof loadAttendanceForPay>>[number]

export async function loadAttendanceForPay(tx: Tx, where: object) {
  return tx.attendanceRecord.findMany({ where, include: ATTENDANCE_FOR_PAY, orderBy: { clockInAt: 'asc' } })
}

export async function roundingFor(tx: Tx, businessId: string): Promise<Rounding> {
  const settings = await tx.teamSettings.findUnique({ where: { businessId } })
  return { minutes: settings?.payRoundingMinutes ?? 30, mode: settings?.payRoundingMode ?? 'FLOOR' }
}

export function rateFor(record: AttendanceForPay): ResolvedRate {
  return resolveRate({
    rateOverrideSen: record.assignment?.rateOverrideSen ?? null,
    attendanceWorkType: record.workType,
    assignmentWorkType: record.assignment?.workType ?? null,
    slotWorkType: record.assignment?.slot.workType ?? null,
    staffDefaultWorkType: record.staff.defaultWorkType,
  })
}

export type DraftLine = {
  kind: 'ATTENDANCE' | 'ADJUSTMENT'
  attendanceId: string | null
  attendanceVersion: number | null
  adjustmentId: string | null
  workDate: string
  clockInAt: string | null
  clockOutAt: string | null
  approvedStartAt: string | null
  approvedEndAt: string | null
  minutes: number
  workTypeName: string
  rateSenPerHour: number
  amountSen: number
  description: string | null
}

/** One approved attendance record as a payslip line, or null if no rate applies. */
export function attendanceLine(record: AttendanceForPay, rounding: Rounding): DraftLine | null {
  const start = record.approvedStartAt ?? record.clockInAt
  const end = record.approvedEndAt ?? record.clockOutAt
  if (!end) return null
  const rate = rateFor(record)
  if (!rate) return null
  const minutes = payableMinutes(start, end, rounding)
  const edited =
    record.approvedStartAt?.getTime() !== record.clockInAt.getTime() ||
    record.approvedEndAt?.getTime() !== record.clockOutAt?.getTime()
  return {
    kind: 'ATTENDANCE',
    attendanceId: record.id,
    attendanceVersion: record.version,
    adjustmentId: null,
    workDate: mytDate(start),
    clockInAt: record.clockInAt.toISOString(),
    clockOutAt: record.clockOutAt?.toISOString() ?? null,
    approvedStartAt: start.toISOString(),
    approvedEndAt: end.toISOString(),
    minutes,
    workTypeName: rate.workTypeName,
    rateSenPerHour: rate.rateSenPerHour,
    amountSen: lineAmountSen(minutes, rate.rateSenPerHour),
    description: edited ? 'Times adjusted by management' : (record.assignment?.slot.label ?? null),
  }
}

/** The instant range covering Malaysia dates `start`…`end` inclusive. */
export function dateRange(start: string, end: string) {
  return {
    gte: new Date(Date.parse(`${start}T00:00:00Z`) - 8 * 3_600_000),
    lt: new Date(Date.parse(`${end}T00:00:00Z`) + 16 * 3_600_000),
  }
}

export type Draft = {
  lines: DraftLine[]
  pendingCount: number
  /** Approved records with nothing to price them by — they block approval. */
  missingRate: Array<{ attendanceId: string; date: string }>
  /** Approved records with no end time yet. */
  missingEnd: Array<{ attendanceId: string; date: string }>
}

/**
 * What a staff member is owed for a period, worked out now: every approved
 * record that starts in it and is not already on a payslip, plus their open
 * adjustments from earlier periods.
 */
export async function draftFor(tx: Tx, businessId: string, staffId: string, start: string, end: string): Promise<Draft> {
  const rounding = await roundingFor(tx, businessId)
  const range = dateRange(start, end)
  const onPayslips = await tx.payslipLine.findMany({
    where: { attendanceId: { not: null }, payslip: { staffId } },
    select: { attendanceId: true },
  })
  const taken = new Set(onPayslips.map((line) => line.attendanceId))
  const records = (await loadAttendanceForPay(tx, { staffId, clockInAt: range })).filter((record) => !taken.has(record.id))

  const lines: DraftLine[] = []
  const missingRate: Draft['missingRate'] = []
  const missingEnd: Draft['missingEnd'] = []
  for (const record of records.filter((candidate) => candidate.status === 'APPROVED')) {
    const date = mytDate(record.approvedStartAt ?? record.clockInAt)
    if (!(record.approvedEndAt ?? record.clockOutAt)) {
      missingEnd.push({ attendanceId: record.id, date })
      continue
    }
    const line = attendanceLine(record, rounding)
    if (!line) missingRate.push({ attendanceId: record.id, date })
    else lines.push(line)
  }

  const adjustments = await tx.payrollAdjustment.findMany({
    where: { staffId, status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
  })
  for (const adjustment of adjustments) {
    lines.push({
      kind: 'ADJUSTMENT',
      attendanceId: adjustment.attendanceId,
      attendanceVersion: null,
      adjustmentId: adjustment.id,
      workDate: mytDate(adjustment.createdAt),
      clockInAt: null,
      clockOutAt: null,
      approvedStartAt: null,
      approvedEndAt: null,
      minutes: adjustment.minutesDelta,
      workTypeName: 'Adjustment',
      rateSenPerHour: 0,
      amountSen: adjustment.amountSen,
      description: adjustment.reason,
    })
  }

  return {
    lines,
    pendingCount: records.filter((record) => record.status === 'PENDING').length,
    missingRate,
    missingEnd,
  }
}

/**
 * React to an attendance record changing after it was put on a payslip.
 *
 * On an approved, unpaid payslip, that payslip goes back to draft so it is
 * worked out again. On a paid one, the paid record is left exactly as it was
 * and the difference becomes an open adjustment for management to settle.
 */
export async function attendanceChanged(
  tx: Tx,
  businessId: string,
  actor: Actor,
  attendanceId: string,
): Promise<void> {
  const lines = await tx.payslipLine.findMany({
    where: { attendanceId, kind: 'ATTENDANCE' },
    include: { payslip: true },
  })
  for (const line of lines) {
    if (line.payslip.status === 'APPROVED') {
      await revertPayslip(tx, businessId, actor, line.payslipId, 'payroll.reverted_after_attendance_edit')
      continue
    }
    // Paid. Work out what it should have been, against what was paid.
    const [record] = await loadAttendanceForPay(tx, { id: attendanceId })
    const rounding = await roundingFor(tx, businessId)
    const now = record && record.status === 'APPROVED' ? attendanceLine(record, rounding) : null
    const shouldBeSen = now?.amountSen ?? 0
    const shouldBeMinutes = now?.minutes ?? 0
    const alreadyOwed = await tx.payrollAdjustment.aggregate({
      where: { attendanceId, causePayslipId: line.payslipId, status: { in: ['OPEN', 'INCLUDED'] } },
      _sum: { amountSen: true, minutesDelta: true },
    })
    const difference = shouldBeSen - line.amountSen - (alreadyOwed._sum.amountSen ?? 0)
    const minutesDelta = shouldBeMinutes - line.minutes - (alreadyOwed._sum.minutesDelta ?? 0)
    if (difference === 0 && minutesDelta === 0) continue

    // Supersede any still-open adjustment for this record so only one stands.
    await tx.payrollAdjustment.updateMany({
      where: { attendanceId, causePayslipId: line.payslipId, status: 'OPEN' },
      data: { status: 'DISMISSED', resolvedAt: new Date(), resolvedNote: 'Superseded by a later change to the same attendance.' },
    })
    const openTotal = await tx.payrollAdjustment.aggregate({
      where: { attendanceId, causePayslipId: line.payslipId, status: 'INCLUDED' },
      _sum: { amountSen: true, minutesDelta: true },
    })
    const amountSen = shouldBeSen - line.amountSen - (openTotal._sum.amountSen ?? 0)
    const minutes = shouldBeMinutes - line.minutes - (openTotal._sum.minutesDelta ?? 0)
    if (amountSen === 0 && minutes === 0) continue
    const money = `RM ${(Math.abs(amountSen) / 100).toFixed(2)}`
    const adjustment = await tx.payrollAdjustment.create({
      data: {
        businessId,
        staffId: line.payslip.staffId,
        attendanceId,
        causePayslipId: line.payslipId,
        amountSen,
        minutesDelta: minutes,
        reason:
          amountSen >= 0
            ? `Attendance on ${mytDate(line.workDate)} changed after payroll was paid. ${money} more may be owed.`
            : `Attendance on ${mytDate(line.workDate)} changed after payroll was paid. ${money} may have been overpaid.`,
      },
    })
    await audit(tx, businessId, actor, {
      action: 'payroll.discrepancy_flagged',
      entityType: 'payroll_adjustment',
      entityId: adjustment.id,
      after: { attendanceId, paidPayslipId: line.payslipId, amountSen, minutesDelta: minutes },
    })
  }
}

/** Return an approved, unpaid payslip to draft. Its adjustments become open again. */
export async function revertPayslip(tx: Tx, businessId: string, actor: Actor, payslipId: string, action: string): Promise<void> {
  const payslip = await tx.payslip.findUnique({ where: { id: payslipId } })
  if (!payslip || payslip.status !== 'APPROVED') return
  await tx.payrollAdjustment.updateMany({
    where: { includedInPayslipId: payslipId },
    data: { status: 'OPEN', includedInPayslipId: null, resolvedAt: null },
  })
  await tx.payslip.delete({ where: { id: payslipId } })
  await audit(tx, businessId, actor, {
    action,
    entityType: 'payslip',
    entityId: payslipId,
    before: { staffId: payslip.staffId, totalSen: payslip.totalSen, periodStart: payslip.periodStart, periodEnd: payslip.periodEnd },
  })
}
