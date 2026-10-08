import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireStaff } from '../auth.ts'
import type { Tx } from '../db.ts'
import { addDays, minutesBetween, mytDate, mytTime, rangeLabel } from '../domain/team-time.ts'
import { conflict, notFound } from '../errors.ts'
import { actorOf, audit } from '../team/audit.ts'
import { fillCoverage, offerNext, openCoverage } from '../team/coverage.ts'
import { draftFor } from '../team/payroll-data.ts'
import { weekPhase } from '../team/roster-data.ts'
import { exportRoster } from './team-roster.ts'

/**
 * Team, staff side: what team.vistahub.my calls once signed in.
 *
 * Everything a staff member can see is built here, field by field. Nothing
 * from management's side of a record — ratings, notes, scores, the engine's
 * reasons, rate overrides on other people's shifts, other people's pay — is
 * ever selected, let alone sent.
 */

const ID = z.string().uuid()
const applicationsBody = z.object({ slotIds: z.array(ID).max(100) })

/** A shift may be clocked into from this long before it starts. */
const EARLY_CLOCK_IN_MS = 60 * 60_000

async function orgName(db: PrismaClient | Tx, businessId: string): Promise<string> {
  const settings = await db.accountSettings.findUnique({ where: { businessId }, select: { businessName: true } })
  return settings?.businessName ?? 'Your workplace'
}

function me(request: FastifyRequest): string {
  if (!request.staffId) throw notFound('team:STAFF_NOT_FOUND')
  return request.staffId
}

/** Is the application window open right now? */
function windowOpen(week: { status: string; applicationsOpenAt: Date | null; applicationsCloseAt: Date | null }, now: Date): boolean {
  if (week.status !== 'APPLICATIONS_OPEN') return false
  if (week.applicationsOpenAt && now < week.applicationsOpenAt) return false
  if (week.applicationsCloseAt && now >= week.applicationsCloseAt) return false
  return true
}

type MyStatus =
  | 'AVAILABLE'
  | 'APPLIED'
  | 'CONFIRMED'
  | 'NOT_ASSIGNED'
  | 'WITHDRAWN'
  | 'REPLACEMENT_OFFERED'
  | 'CLOSED'

export async function teamStaffRoutes(app: FastifyInstance): Promise<void> {
  const staffOnly = { preHandler: requireStaff }

  app.post('/team/auth/logout', staffOnly, async (request) => {
    await request.db.session.update({ where: { id: request.user.sid }, data: { revokedAt: new Date() } })
    return { ok: true }
  })

  app.get('/team/me', staffOnly, async (request) => {
    const staff = await request.db.staffMember.findUniqueOrThrow({
      where: { id: me(request) },
      select: { id: true, name: true, staffCode: true },
    })
    return {
      staff,
      org: { id: request.businessId, name: await orgName(request.db, request.businessId) },
      viewOnly: Boolean(request.user.viewOnly),
    }
  })

  /** The front page: am I clocked in, offers waiting for me, my next shifts. */
  app.get('/team/home', staffOnly, async (request) => {
    const staffId = me(request)
    const { db } = request
    const now = new Date()
    const [open, offers, upcoming, openWeeks] = await Promise.all([
      db.attendanceRecord.findFirst({
        where: { staffId, clockOutAt: null, status: { not: 'REJECTED' } },
        include: { assignment: { select: { slot: { select: { startsAt: true, endsAt: true, label: true } } } } },
      }),
      db.replacementOffer.findMany({
        where: { staffId, status: 'PENDING', coverageRequest: { status: 'OPEN' } },
        include: { coverageRequest: { select: { isUrgent: true, slot: { select: { startsAt: true, endsAt: true, label: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      db.assignment.findMany({
        where: {
          staffId,
          status: 'ACTIVE',
          slot: { endsAt: { gt: now }, rosterWeek: { status: 'PUBLISHED' } },
        },
        include: { slot: { select: { startsAt: true, endsAt: true, label: true, rosterWeek: { select: { withdrawalDeadlineHours: true } } } } },
        orderBy: { slot: { startsAt: 'asc' } },
        take: 10,
      }),
      db.rosterWeek.findMany({ where: { status: 'APPLICATIONS_OPEN' }, select: { status: true, applicationsOpenAt: true, applicationsCloseAt: true } }),
    ])

    return {
      clockedIn: open
        ? {
            id: open.id,
            since: open.clockInAt.toISOString(),
            shift: open.assignment
              ? { startTime: mytTime(open.assignment.slot.startsAt), endTime: mytTime(open.assignment.slot.endsAt), label: open.assignment.slot.label }
              : null,
          }
        : null,
      offers: offers.map((offer) => ({
        id: offer.id,
        isUrgent: offer.coverageRequest.isUrgent,
        date: mytDate(offer.coverageRequest.slot.startsAt),
        startTime: mytTime(offer.coverageRequest.slot.startsAt),
        endTime: mytTime(offer.coverageRequest.slot.endsAt),
        minutes: minutesBetween(offer.coverageRequest.slot.startsAt, offer.coverageRequest.slot.endsAt),
        label: offer.coverageRequest.slot.label,
      })),
      upcoming: upcoming.map((assignment) => ({
        assignmentId: assignment.id,
        date: mytDate(assignment.slot.startsAt),
        startTime: mytTime(assignment.slot.startsAt),
        endTime: mytTime(assignment.slot.endsAt),
        minutes: minutesBetween(assignment.slot.startsAt, assignment.slot.endsAt),
        label: assignment.slot.label,
        canWithdraw:
          assignment.slot.startsAt.getTime() - now.getTime() > assignment.slot.rosterWeek.withdrawalDeadlineHours * 3_600_000,
        withdrawBy: new Date(assignment.slot.startsAt.getTime() - assignment.slot.rosterWeek.withdrawalDeadlineHours * 3_600_000).toISOString(),
      })),
      applicationsOpen: openWeeks.some((week) => windowOpen(week, now)),
    }
  })

  /**
   * The weeks a staff member can see, each shift with *their* status on it.
   * Draft weeks are invisible. Before publishing, nobody else's name is shown;
   * after, the shift shows who is working it — the same as the shared roster.
   */
  app.get('/team/weeks', staffOnly, async (request) => {
    const staffId = me(request)
    const { db } = request
    const now = new Date()
    const weeks = await db.rosterWeek.findMany({
      where: {
        status: { not: 'DRAFT' },
        weekStart: { gte: new Date(Date.now() - 14 * 86_400_000) },
      },
      orderBy: { weekStart: 'asc' },
      include: {
        slots: {
          orderBy: { startsAt: 'asc' },
          include: {
            applications: { where: { status: 'APPLIED' }, select: { staffId: true } },
            assignments: { select: { id: true, staffId: true, status: true, staff: { select: { name: true } } } },
            coverage: {
              where: { status: 'OPEN' },
              select: { offers: { where: { staffId, status: 'PENDING' }, select: { id: true } } },
            },
          },
        },
      },
    })

    return {
      weeks: weeks.map((week) => {
        const start = week.weekStart.toISOString().slice(0, 10)
        const published = week.status === 'PUBLISHED'
        const open = windowOpen(week, now)
        const appliedCount = week.slots.filter((slot) => slot.applications.some((application) => application.staffId === staffId)).length
        return {
          id: week.id,
          weekStart: start,
          label: rangeLabel(start, addDays(start, 6)),
          stage: published ? weekPhase(week, now) : open ? 'APPLICATIONS_OPEN' : 'IN_REVIEW',
          applicationsOpen: open,
          applicationsCloseAt: week.applicationsCloseAt?.toISOString() ?? null,
          applicationLimit: week.applicationLimit,
          appliedCount,
          withdrawalDeadlineHours: week.withdrawalDeadlineHours,
          slots: week.slots.map((slot) => {
            const mine = slot.assignments.find((assignment) => assignment.staffId === staffId && assignment.status === 'ACTIVE')
            const withdrew = slot.assignments.some((assignment) => assignment.staffId === staffId && assignment.status === 'WITHDRAWN')
            const applied = slot.applications.some((application) => application.staffId === staffId)
            const offer = slot.coverage.flatMap((item) => item.offers)[0]
            let status: MyStatus
            if (published && offer) status = 'REPLACEMENT_OFFERED'
            else if (published && mine) status = 'CONFIRMED'
            else if (published && withdrew) status = 'WITHDRAWN'
            else if (published && applied) status = 'NOT_ASSIGNED'
            else if (applied) status = 'APPLIED'
            else if (open) status = 'AVAILABLE'
            else status = 'CLOSED'
            const withdrawCutoff = slot.startsAt.getTime() - week.withdrawalDeadlineHours * 3_600_000
            return {
              id: slot.id,
              date: mytDate(slot.startsAt),
              startTime: mytTime(slot.startsAt),
              endTime: mytTime(slot.endsAt),
              minutes: minutesBetween(slot.startsAt, slot.endsAt),
              label: slot.label,
              myStatus: status,
              assignmentId: mine?.id ?? null,
              offerId: offer?.id ?? null,
              canApply: open && !applied,
              canUnapply: open && applied,
              canWithdraw: Boolean(mine) && published && now.getTime() < withdrawCutoff,
              withdrawBy: new Date(withdrawCutoff).toISOString(),
              // How many have applied, never who: the live counter on each shift.
              applicantCount: slot.applications.length,
              needed: slot.requiredStaff,
              // A shift already under way can no longer be applied for.
              started: slot.startsAt.getTime() <= now.getTime(),
              // Only once published, and only names: the same as the shared roster.
              workingWith: published
                ? slot.assignments
                    .filter((assignment) => assignment.status === 'ACTIVE' && assignment.staffId !== staffId)
                    .map((assignment) => assignment.staff.name)
                : [],
            }
          }),
        }
      }),
    }
  })

  /** The week's roster as shared with everyone: days, times, names. Published weeks only. */
  app.get<{ Params: { id: string } }>('/team/weeks/:id/roster', staffOnly, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const week = await db.rosterWeek.findUnique({ where: { id }, select: { status: true } })
    if (!week || week.status !== 'PUBLISHED') throw notFound('team:WEEK_NOT_FOUND')
    return db.$transaction((tx) => exportRoster(tx, businessId, id))
  })

  /** "I can work this one." Refused outside the window or past the limit. */
  app.post<{ Params: { id: string } }>('/team/slots/:id/apply', staffOnly, async (request) => {
    const slotId = ID.parse(request.params.id)
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const slot = await tx.shiftSlot.findUnique({ where: { id: slotId }, include: { rosterWeek: true } })
      if (!slot) throw notFound('team:SHIFT_NOT_FOUND')
      if (!windowOpen(slot.rosterWeek, now)) throw conflict('team:APPLICATIONS_CLOSED')
      // Serialise this person's applications for the week so the limit holds under double taps.
      await tx.$queryRaw`SELECT id FROM staff_members WHERE id = ${staffId} AND business_id = ${businessId} FOR UPDATE`
      const count = await tx.shiftApplication.count({
        where: { staffId, status: 'APPLIED', slot: { rosterWeekId: slot.rosterWeekId }, NOT: { slotId } },
      })
      if (count >= slot.rosterWeek.applicationLimit) throw conflict('team:APPLICATION_LIMIT')
      await tx.shiftApplication.upsert({
        where: { slotId_staffId: { slotId, staffId } },
        update: { status: 'APPLIED' },
        create: { businessId, slotId, staffId },
      })
      await audit(tx, businessId, actor, { action: 'application.applied', entityType: 'shift', entityId: slotId })
    })
    return { ok: true }
  })

  /**
   * Submit this week's applications in one go: exactly these shifts, no
   * others. Staff pick on the phone and confirm with one button, and can
   * submit a changed set as often as they like while applications are open.
   */
  app.put<{ Params: { id: string } }>('/team/weeks/:id/applications', staffOnly, async (request) => {
    const weekId = ID.parse(request.params.id)
    const { slotIds } = applicationsBody.parse(request.body)
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const wanted = new Set(slotIds)
    return db.$transaction(async (tx) => {
      const week = await tx.rosterWeek.findUnique({ where: { id: weekId }, include: { slots: { select: { id: true, startsAt: true } } } })
      if (!week) throw notFound('team:WEEK_NOT_FOUND')
      if (!windowOpen(week, new Date())) throw conflict('team:APPLICATIONS_CLOSED')
      const inWeek = new Set(week.slots.map((slot) => slot.id))
      if ([...wanted].some((id) => !inWeek.has(id))) throw notFound('team:SHIFT_NOT_FOUND')
      if (wanted.size > week.applicationLimit) throw conflict('team:APPLICATION_LIMIT')
      // One submission at a time per person, so a double tap cannot interleave.
      await tx.$queryRaw`SELECT id FROM staff_members WHERE id = ${staffId} AND business_id = ${businessId} FOR UPDATE`

      const current = await tx.shiftApplication.findMany({
        where: { staffId, status: 'APPLIED', slot: { rosterWeekId: weekId } },
        select: { slotId: true },
      })
      const had = new Set(current.map((application) => application.slotId))
      const added = [...wanted].filter((id) => !had.has(id))
      const now = new Date()
      const started = new Set(week.slots.filter((slot) => slot.startsAt <= now).map((slot) => slot.id))
      if (added.some((id) => started.has(id))) throw conflict('team:SHIFT_STARTED')
      const removed = [...had].filter((id) => !wanted.has(id))
      if (removed.length > 0) {
        await tx.shiftApplication.updateMany({ where: { staffId, slotId: { in: removed } }, data: { status: 'WITHDRAWN' } })
      }
      for (const slotId of added) {
        await tx.shiftApplication.upsert({
          where: { slotId_staffId: { slotId, staffId } },
          // A shift picked again counts from now, like a fresh application.
          update: { status: 'APPLIED', createdAt: new Date() },
          create: { businessId, slotId, staffId },
        })
      }
      if (added.length + removed.length > 0) {
        await audit(tx, businessId, actor, {
          action: 'application.submitted',
          entityType: 'roster_week',
          entityId: weekId,
          after: { added, removed, total: wanted.size },
        })
      }
      return { ok: true, applied: wanted.size, added: added.length, removed: removed.length }
    })
  })

  app.delete<{ Params: { id: string } }>('/team/slots/:id/apply', staffOnly, async (request) => {
    const slotId = ID.parse(request.params.id)
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const slot = await tx.shiftSlot.findUnique({ where: { id: slotId }, include: { rosterWeek: true } })
      if (!slot) throw notFound('team:SHIFT_NOT_FOUND')
      if (!windowOpen(slot.rosterWeek, new Date())) throw conflict('team:APPLICATIONS_CLOSED')
      await tx.shiftApplication.updateMany({ where: { slotId, staffId }, data: { status: 'WITHDRAWN' } })
      await audit(tx, businessId, actor, { action: 'application.withdrawn', entityType: 'shift', entityId: slotId })
    })
    return { ok: true }
  })

  /**
   * "I can't work this one." Before the deadline the staff member comes off
   * the shift, and the replacement queue starts. After it, only management can
   * take them off.
   */
  app.post<{ Params: { id: string } }>('/team/assignments/:id/withdraw', staffOnly, async (request) => {
    const id = ID.parse(request.params.id)
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const assignment = await tx.assignment.findUnique({ where: { id }, include: { slot: { include: { rosterWeek: true } } } })
      if (!assignment || assignment.staffId !== staffId || assignment.status !== 'ACTIVE') {
        throw notFound('team:ASSIGNMENT_NOT_FOUND')
      }
      if (assignment.slot.rosterWeek.status !== 'PUBLISHED') throw conflict('team:NOT_PUBLISHED')
      const cutoff = assignment.slot.startsAt.getTime() - assignment.slot.rosterWeek.withdrawalDeadlineHours * 3_600_000
      if (now.getTime() >= cutoff) throw conflict('team:WITHDRAW_DEADLINE_PASSED')
      const done = await tx.assignment.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'WITHDRAWN', endedAt: now } })
      if (done.count !== 1) throw conflict('team:ASSIGNMENT_NOT_FOUND')
      await tx.rosterWeek.update({ where: { id: assignment.slot.rosterWeekId }, data: { version: { increment: 1 } } })
      await audit(tx, businessId, actor, {
        action: 'roster.staff_withdrew',
        entityType: 'assignment',
        entityId: id,
        before: { slotId: assignment.slotId, staffId },
      })
      await openCoverage(tx, businessId, actor, assignment.slotId, id, now)
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/team/offers/:id/accept', staffOnly, async (request) => {
    const id = ID.parse(request.params.id)
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const offer = await tx.replacementOffer.findUnique({ where: { id }, include: { coverageRequest: { include: { slot: true } } } })
      if (!offer || offer.staffId !== staffId) throw notFound('team:OFFER_NOT_FOUND')
      if (offer.status !== 'PENDING' || offer.coverageRequest.status !== 'OPEN') throw conflict('team:OFFER_GONE')
      if (offer.coverageRequest.slot.startsAt <= now) throw conflict('team:OFFER_GONE')
      const slot = offer.coverageRequest.slot
      const clash = await tx.assignment.findFirst({
        where: { staffId, status: 'ACTIVE', slot: { startsAt: { lt: slot.endsAt }, endsAt: { gt: slot.startsAt } } },
      })
      if (clash) throw conflict('team:OFFER_CLASH')
      await fillCoverage(tx, businessId, actor, offer.coverageRequestId, staffId, 'ACCEPTED', now)
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/team/offers/:id/reject', staffOnly, async (request) => {
    const id = ID.parse(request.params.id)
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const offer = await tx.replacementOffer.findUnique({ where: { id } })
      if (!offer || offer.staffId !== staffId) throw notFound('team:OFFER_NOT_FOUND')
      const done = await tx.replacementOffer.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', respondedAt: now } })
      if (done.count !== 1) throw conflict('team:OFFER_GONE')
      await audit(tx, businessId, actor, { action: 'coverage.rejected_by_staff', entityType: 'coverage', entityId: offer.coverageRequestId })
      await offerNext(tx, businessId, offer.coverageRequestId, now)
    })
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Clocking in and out — a claim until management approves it.
  // -------------------------------------------------------------------------

  app.post('/team/attendance/clock-in', staffOnly, async (request) => {
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    const record = await db.$transaction(async (tx) => {
      const open = await tx.attendanceRecord.findFirst({ where: { staffId, clockOutAt: null, status: { not: 'REJECTED' } } })
      if (open) throw conflict('team:ALREADY_CLOCKED_IN')
      // The rostered shift this is for: the one under way, or about to start.
      const assignment = await tx.assignment.findFirst({
        where: {
          staffId,
          status: 'ACTIVE',
          slot: {
            rosterWeek: { status: 'PUBLISHED' },
            startsAt: { lte: new Date(now.getTime() + EARLY_CLOCK_IN_MS) },
            endsAt: { gt: now },
          },
        },
        orderBy: { slot: { startsAt: 'asc' } },
      })
      const created = await tx.attendanceRecord.create({
        data: { businessId, staffId, assignmentId: assignment?.id ?? null, clockInAt: now, source: 'TEAM_APP' },
      })
      await audit(tx, businessId, actor, { action: 'attendance.clocked_in', entityType: 'attendance', entityId: created.id, after: { assignmentId: assignment?.id ?? null } })
      return created
    })
    return { id: record.id, clockInAt: record.clockInAt.toISOString(), rostered: record.assignmentId !== null }
  })

  app.post('/team/attendance/clock-out', staffOnly, async (request) => {
    const staffId = me(request)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    const record = await db.$transaction(async (tx) => {
      const open = await tx.attendanceRecord.findFirst({ where: { staffId, clockOutAt: null, status: { not: 'REJECTED' } } })
      if (!open) throw conflict('team:NOT_CLOCKED_IN')
      const closed = await tx.attendanceRecord.update({
        where: { id: open.id },
        data: { clockOutAt: new Date(Math.max(now.getTime(), open.clockInAt.getTime() + 1000)) },
      })
      await audit(tx, businessId, actor, { action: 'attendance.clocked_out', entityType: 'attendance', entityId: open.id })
      return closed
    })
    return {
      id: record.id,
      clockInAt: record.clockInAt.toISOString(),
      clockOutAt: record.clockOutAt?.toISOString() ?? null,
      minutes: record.clockOutAt ? minutesBetween(record.clockInAt, record.clockOutAt) : 0,
    }
  })

  /** My recent clock-ins, and whether management has approved them yet. */
  app.get('/team/attendance', staffOnly, async (request) => {
    const staffId = me(request)
    const records = await request.db.attendanceRecord.findMany({
      where: { staffId, clockInAt: { gte: new Date(Date.now() - 35 * 86_400_000) } },
      orderBy: { clockInAt: 'desc' },
      take: 60,
      select: { id: true, clockInAt: true, clockOutAt: true, status: true, approvedStartAt: true, approvedEndAt: true },
    })
    return {
      attendance: records.map((record) => ({
        id: record.id,
        date: mytDate(record.clockInAt),
        clockInAt: record.clockInAt.toISOString(),
        clockOutAt: record.clockOutAt?.toISOString() ?? null,
        status: record.status,
        approvedStartAt: record.approvedStartAt?.toISOString() ?? null,
        approvedEndAt: record.approvedEndAt?.toISOString() ?? null,
      })),
    }
  })

  /**
   * My own pay: approved and paid payslips, line by line, plus what approved
   * time not yet on a payslip comes to. Nobody else's, ever.
   */
  app.get('/team/pay', staffOnly, async (request) => {
    const staffId = me(request)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      const payslips = await tx.payslip.findMany({
        where: { staffId },
        orderBy: { periodStart: 'desc' },
        take: 12,
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      })
      const today = mytDate(new Date())
      const sinceLast = await draftFor(tx, businessId, staffId, addDays(today, -62), today)
      const unpaid = sinceLast.lines.filter((line) => line.kind === 'ATTENDANCE')
      return {
        notYetOnPayslip: {
          minutes: unpaid.reduce((sum, line) => sum + line.minutes, 0),
          amountSen: unpaid.reduce((sum, line) => sum + line.amountSen, 0),
          awaitingApproval: sinceLast.pendingCount,
        },
        payslips: payslips.map((payslip) => {
          const start = payslip.periodStart.toISOString().slice(0, 10)
          const end = payslip.periodEnd.toISOString().slice(0, 10)
          return {
            id: payslip.id,
            label: rangeLabel(start, end),
            status: payslip.status,
            totalMinutes: payslip.totalMinutes,
            totalSen: payslip.totalSen,
            paidOn: payslip.paidOn?.toISOString().slice(0, 10) ?? null,
            lines: payslip.lines.map((line) => ({
              kind: line.kind,
              date: line.workDate.toISOString().slice(0, 10),
              startTime: line.clockInAt ? mytTime(line.clockInAt) : null,
              endTime: line.clockOutAt ? mytTime(line.clockOutAt) : null,
              minutes: line.minutes,
              workTypeName: line.workTypeName,
              rateSenPerHour: line.rateSenPerHour,
              amountSen: line.amountSen,
              description: line.kind === 'ADJUSTMENT' ? 'Correction from an earlier payslip' : null,
            })),
          }
        }),
      }
    })
  })
}
