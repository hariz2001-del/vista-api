import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requirePermission } from '../auth.ts'
import type { Tx } from '../db.ts'
import { evaluateRoster, generateRoster, warningsForPlacement } from '../domain/rostering.ts'
import {
  addDays,
  HHMM,
  ISO_DATE,
  isMonday,
  minutesBetween,
  mytDate,
  mytTime,
  rangeLabel,
  shiftInstants,
  weekdayOf,
} from '../domain/team-time.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { actorOf, audit } from '../team/audit.ts'
import { fillCoverage, offerNext, openCoverage, replacementQueue } from '../team/coverage.ts'
import {
  activePlacements,
  engineInputFor,
  loadEngineStaff,
  loadWeek,
  touchWeek,
  weekPhase,
  type LoadedWeek,
} from '../team/roster-data.ts'
import { teamSettingsFor } from './team-rms.ts'

/**
 * Team, management side: opening hours, the usual week's shifts, roster weeks
 * from draft to published, the engine's suggestion, manual changes, export,
 * and covering vacancies. The system recommends; management decides — every
 * warning here informs and none of them blocks.
 */

const ID = z.string().uuid()
const DATE = z.string().regex(ISO_DATE)
const TIME = z.string().regex(HHMM)
const INSTANT = z.string().datetime({ offset: true })
const TAGS = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20)

const hoursBody = z.object({
  days: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), isClosed: z.boolean(), opensAt: TIME, closesAt: TIME }))
    .max(7),
})

const closedBody = z.object({ startDate: DATE, endDate: DATE, reason: z.string().trim().max(120).nullish() })

const templateItem = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: TIME,
  endTime: TIME,
  requiredStaff: z.number().int().min(1).max(50).default(1),
  canRunSolo: z.boolean().default(true),
  roleTags: TAGS.default([]),
  workTypeId: ID.nullish(),
  label: z.string().trim().max(40).nullish(),
})
const templatesBody = z.object({ templates: z.array(templateItem).max(200) })

const weekWindow = {
  applicationsOpenAt: INSTANT.nullish(),
  applicationsCloseAt: INSTANT.nullish(),
  reviewDeadline: INSTANT.nullish(),
  publishDeadline: INSTANT.nullish(),
}
const weekCreate = z.object({
  weekStart: DATE,
  fromTemplate: z.boolean().default(true),
  /** Copy this earlier week's shifts (times, staff needed, labels — not people). Wins over the template. */
  copyFromWeekId: ID.nullish(),
  ...weekWindow,
})
const copyDayBody = z.object({ fromDate: DATE })
const weekUpdate = z
  .object({
    ...weekWindow,
    applicationLimit: z.number().int().min(0).max(100),
    assignmentTargetShifts: z.number().int().min(0).max(50),
    assignmentMaxShifts: z.number().int().min(0).max(50),
    assignmentMaxMinutes: z.number().int().min(0).max(10_080),
    withdrawalDeadlineHours: z.number().int().min(0).max(336),
  })
  .partial()
const statusBody = z.object({ status: z.enum(['DRAFT', 'APPLICATIONS_OPEN', 'APPLICATIONS_CLOSED', 'IN_REVIEW']) })

const slotBody = z.object({
  date: DATE,
  startTime: TIME,
  endTime: TIME,
  requiredStaff: z.number().int().min(1).max(50).default(1),
  canRunSolo: z.boolean().default(true),
  roleTags: TAGS.default([]),
  workTypeId: ID.nullish(),
  label: z.string().trim().max(40).nullish(),
})
const slotUpdate = slotBody.partial()

const assignBody = z.object({ staffId: ID, isLocked: z.boolean().default(false), workTypeId: ID.nullish() })
const assignmentUpdate = z
  .object({
    isLocked: z.boolean(),
    workTypeId: ID.nullable(),
    rateOverrideSen: z.number().int().min(0).max(1_000_000).nullable(),
    rateOverrideReason: z.string().trim().max(200).nullable(),
  })
  .partial()
const removeQuery = z.object({ vacancy: z.enum(['true', 'false']).default('true') })
const confirmBody = z.object({ staffId: ID })

const toDate = (value: string) => new Date(`${value}T00:00:00Z`)
const instantOrNull = (value: string | null | undefined) => (value ? new Date(value) : value === null ? null : undefined)

async function requireWeek(tx: Tx, id: string): Promise<LoadedWeek> {
  const week = await loadWeek(tx, id)
  if (!week) throw notFound('team:WEEK_NOT_FOUND')
  return week
}

async function assertWorkType(tx: Tx, id: string | null | undefined): Promise<void> {
  if (id && !(await tx.workType.findUnique({ where: { id } }))) throw badRequest('team:WORK_TYPE_NOT_FOUND')
}

/** Slot times for a date inside a week. */
function slotTimes(weekStart: string, body: { date: string; startTime: string; endTime: string }) {
  const offset = Math.round((Date.parse(`${body.date}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / 86_400_000)
  if (offset < 0 || offset > 6) throw badRequest('team:DATE_OUTSIDE_WEEK')
  return shiftInstants(body.date, body.startTime, body.endTime)
}

/** Minutes each staff member was rostered in the four weeks before this one. */
async function trailingMinutes(tx: Tx, weekStart: Date): Promise<Map<string, number>> {
  const start = new Date(weekStart.getTime() - 8 * 3_600_000)
  const assignments = await tx.assignment.findMany({
    where: {
      status: 'ACTIVE',
      slot: { startsAt: { gte: new Date(start.getTime() - 28 * 86_400_000), lt: start } },
    },
    select: { staffId: true, slot: { select: { startsAt: true, endsAt: true } } },
  })
  const totals = new Map<string, number>()
  for (const assignment of assignments) {
    totals.set(
      assignment.staffId,
      (totals.get(assignment.staffId) ?? 0) + minutesBetween(assignment.slot.startsAt, assignment.slot.endsAt),
    )
  }
  return totals
}

/** Everything the roster screen shows for one week. Management only. */
async function weekDetail(tx: Tx, businessId: string, weekId: string) {
  const week = await requireWeek(tx, weekId)
  const input = await engineInputFor(tx, businessId, week)
  const placements = activePlacements(week)
  const { warnings, fairness } = evaluateRoster(input, placements)
  const trailing = await trailingMinutes(tx, week.weekStart)
  const staffRows = await tx.staffMember.findMany({
    where: { id: { in: input.staff.map((staff) => staff.id) } },
    select: { id: true, name: true, staffCode: true, status: true, roleTags: true, defaultWorkTypeId: true },
    orderBy: { name: 'asc' },
  })
  const attributes = new Map(input.staff.map((staff) => [staff.id, staff.attributes]))

  return {
    week: serialiseWeek(week),
    slots: week.slots.map((slot) => ({
      id: slot.id,
      date: mytDate(slot.startsAt),
      startTime: mytTime(slot.startsAt),
      endTime: mytTime(slot.endsAt),
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      minutes: minutesBetween(slot.startsAt, slot.endsAt),
      requiredStaff: slot.requiredStaff,
      canRunSolo: slot.canRunSolo,
      roleTags: slot.roleTags,
      workTypeId: slot.workTypeId,
      label: slot.label,
      applicants: slot.applications.map((application) => ({
        staffId: application.staffId,
        appliedAt: application.createdAt.toISOString(),
      })),
      assignments: slot.assignments.map((assignment) => ({
        id: assignment.id,
        staffId: assignment.staffId,
        staffName: assignment.staff.name,
        status: assignment.status,
        source: assignment.source,
        isLocked: assignment.isLocked,
        workTypeId: assignment.workTypeId,
        rateOverrideSen: assignment.rateOverrideSen,
        rateOverrideReason: assignment.rateOverrideReason,
        explanation: assignment.explanation,
      })),
      // Who left the seat, and who is being asked now (null: nobody left to ask).
      openCoverage: slot.coverage[0]
        ? {
            id: slot.coverage[0].id,
            isUrgent: slot.coverage[0].isUrgent,
            vacatedBy: slot.coverage[0].vacatedAssignment?.staff.name ?? null,
            askingName: slot.coverage[0].offers[0]?.staff.name ?? null,
          }
        : null,
    })),
    staff: staffRows.map((staff) => ({
      id: staff.id,
      name: staff.name,
      staffCode: staff.staffCode,
      status: staff.status,
      roleTags: staff.roleTags,
      defaultWorkTypeId: staff.defaultWorkTypeId,
      soloSuitability: attributes.get(staff.id)?.soloSuitability ?? 'SUITABLE',
      trainingStatus: attributes.get(staff.id)?.trainingStatus ?? 'TRAINED',
      trailingMinutes: trailing.get(staff.id) ?? 0,
    })),
    fairness,
    warnings,
  }
}

function serialiseWeek(week: LoadedWeek | Awaited<ReturnType<Tx['rosterWeek']['findUniqueOrThrow']>>) {
  const start = week.weekStart.toISOString().slice(0, 10)
  return {
    id: week.id,
    weekStart: start,
    weekEnd: addDays(start, 6),
    label: rangeLabel(start, addDays(start, 6)),
    status: week.status,
    phase: weekPhase(week, new Date()),
    applicationsOpenAt: week.applicationsOpenAt?.toISOString() ?? null,
    applicationsCloseAt: week.applicationsCloseAt?.toISOString() ?? null,
    reviewDeadline: week.reviewDeadline?.toISOString() ?? null,
    publishDeadline: week.publishDeadline?.toISOString() ?? null,
    applicationLimit: week.applicationLimit,
    assignmentTargetShifts: week.assignmentTargetShifts,
    assignmentMaxShifts: week.assignmentMaxShifts,
    assignmentMaxMinutes: week.assignmentMaxMinutes,
    withdrawalDeadlineHours: week.withdrawalDeadlineHours,
    generatedAt: week.generatedAt?.toISOString() ?? null,
    reviewedAt: week.reviewedAt?.toISOString() ?? null,
    publishedAt: week.publishedAt?.toISOString() ?? null,
    updatedAt: week.updatedAt.toISOString(),
    version: week.version,
  }
}

/**
 * The roster as it may be shared: days, times and names. Built from scratch,
 * not from the management view, so nothing confidential can ride along.
 */
export async function exportRoster(tx: Tx, businessId: string, weekId: string) {
  const week = await tx.rosterWeek.findUnique({
    where: { id: weekId },
    include: {
      slots: {
        orderBy: { startsAt: 'asc' },
        include: {
          assignments: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'asc' },
            select: { staff: { select: { name: true } } },
          },
        },
      },
    },
  })
  if (!week) throw notFound('team:WEEK_NOT_FOUND')
  const settings = await tx.accountSettings.findUnique({ where: { businessId }, select: { businessName: true } })
  const start = week.weekStart.toISOString().slice(0, 10)
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index)).map((date) => ({
    date,
    label: new Intl.DateTimeFormat('en-MY', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    ),
    shifts: week.slots
      .filter((slot) => mytDate(slot.startsAt) === date)
      .map((slot) => ({
        startTime: mytTime(slot.startsAt),
        endTime: mytTime(slot.endsAt),
        label: slot.label,
        staff: slot.assignments.map((assignment) => assignment.staff.name),
      })),
  }))
  return {
    businessName: settings?.businessName ?? '',
    weekStart: start,
    weekEnd: addDays(start, 6),
    label: rangeLabel(start, addDays(start, 6)),
    isPublished: week.status === 'PUBLISHED',
    updatedAt: week.updatedAt.toISOString(),
    days,
  }
}

export async function teamRosterRoutes(app: FastifyInstance): Promise<void> {
  const roster = { preHandler: requirePermission('roster.manage') }
  const coverage = { preHandler: requirePermission('coverage.manage') }

  // -------------------------------------------------------------------------
  // Opening hours, closed days and the usual week
  // -------------------------------------------------------------------------

  app.get('/rms/team/schedule-setup', roster, async (request) => {
    const { db } = request
    const [hours, closed, templates] = await Promise.all([
      db.operatingHours.findMany({ orderBy: { weekday: 'asc' } }),
      db.closedPeriod.findMany({ orderBy: { startDate: 'asc' } }),
      db.slotTemplate.findMany({ orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] }),
    ])
    return {
      operatingHours: hours.map(({ weekday, isClosed, opensAt, closesAt }) => ({ weekday, isClosed, opensAt, closesAt })),
      closedPeriods: closed.map((period) => ({
        id: period.id,
        startDate: period.startDate.toISOString().slice(0, 10),
        endDate: period.endDate.toISOString().slice(0, 10),
        reason: period.reason,
      })),
      templates: templates.map(({ id, weekday, startTime, endTime, requiredStaff, canRunSolo, roleTags, workTypeId, label }) => ({
        id, weekday, startTime, endTime, requiredStaff, canRunSolo, roleTags, workTypeId, label,
      })),
    }
  })

  app.put('/rms/team/operating-hours', roster, async (request) => {
    const body = hoursBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      for (const day of body.days) {
        await tx.operatingHours.upsert({
          where: { businessId_weekday: { businessId, weekday: day.weekday } },
          update: { isClosed: day.isClosed, opensAt: day.opensAt, closesAt: day.closesAt },
          create: { businessId, ...day },
        })
      }
      await audit(tx, businessId, actor, { action: 'schedule.hours_changed', entityType: 'schedule', after: body.days })
    })
    return { ok: true }
  })

  app.post('/rms/team/closed-periods', roster, async (request) => {
    const body = closedBody.parse(request.body)
    if (body.endDate < body.startDate) throw badRequest('team:RANGE_BACKWARDS')
    const { db, businessId } = request
    const actor = await actorOf(request)
    const period = await db.$transaction(async (tx) => {
      const created = await tx.closedPeriod.create({
        data: { businessId, startDate: toDate(body.startDate), endDate: toDate(body.endDate), reason: body.reason ?? null },
      })
      await audit(tx, businessId, actor, { action: 'schedule.closed_period_added', entityType: 'schedule', entityId: created.id, after: body })
      return created
    })
    return { id: period.id }
  })

  app.delete<{ Params: { id: string } }>('/rms/team/closed-periods/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const removed = await tx.closedPeriod.deleteMany({ where: { id } })
      if (removed.count === 0) throw notFound('team:NOT_FOUND')
      await audit(tx, businessId, actor, { action: 'schedule.closed_period_removed', entityType: 'schedule', entityId: id })
    })
    return { ok: true }
  })

  /** Replace the usual week's shifts. Existing roster weeks are not touched. */
  app.put('/rms/team/slot-templates', roster, async (request) => {
    const body = templatesBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      for (const template of body.templates) await assertWorkType(tx, template.workTypeId)
      await tx.slotTemplate.deleteMany({})
      for (const template of body.templates) {
        await tx.slotTemplate.create({
          data: { businessId, ...template, workTypeId: template.workTypeId ?? null, label: template.label ?? null },
        })
      }
      await audit(tx, businessId, actor, { action: 'schedule.templates_changed', entityType: 'schedule', after: body.templates })
    })
    return { ok: true }
  })

  // -------------------------------------------------------------------------
  // Roster weeks
  // -------------------------------------------------------------------------

  app.get('/rms/team/weeks', roster, async (request) => {
    const weeks = await request.db.rosterWeek.findMany({
      orderBy: { weekStart: 'desc' },
      take: 26,
      include: {
        slots: {
          select: {
            requiredStaff: true,
            assignments: { where: { status: 'ACTIVE' }, select: { id: true } },
            applications: { where: { status: 'APPLIED' }, select: { staffId: true } },
          },
        },
      },
    })
    return {
      weeks: weeks.map((week) => {
        const seats = week.slots.reduce((sum, slot) => sum + slot.requiredStaff, 0)
        const filled = week.slots.reduce((sum, slot) => sum + Math.min(slot.requiredStaff, slot.assignments.length), 0)
        const applicants = new Set(week.slots.flatMap((slot) => slot.applications.map((application) => application.staffId)))
        return Object.assign(serialiseWeek(week), { shiftCount: week.slots.length, seats, filled, applicantCount: applicants.size })
      }),
    }
  })

  /**
   * Start a week. Its limits and deadline are copied from the team settings,
   * and its shifts from the usual week — skipping closed weekdays and closed
   * dates. Everything can be edited afterwards.
   */
  app.post('/rms/team/weeks', roster, async (request) => {
    const body = weekCreate.parse(request.body)
    if (!isMonday(body.weekStart)) throw badRequest('team:WEEK_NOT_MONDAY')
    const { db, businessId } = request
    const actor = await actorOf(request)

    const weekId = await db.$transaction(async (tx) => {
      if (await tx.rosterWeek.findFirst({ where: { weekStart: toDate(body.weekStart) } })) {
        throw conflict('team:WEEK_EXISTS')
      }
      const settings = await teamSettingsFor(tx, businessId)
      const week = await tx.rosterWeek.create({
        data: {
          businessId,
          weekStart: toDate(body.weekStart),
          applicationsOpenAt: instantOrNull(body.applicationsOpenAt) ?? null,
          applicationsCloseAt: instantOrNull(body.applicationsCloseAt) ?? null,
          reviewDeadline: instantOrNull(body.reviewDeadline) ?? null,
          publishDeadline: instantOrNull(body.publishDeadline) ?? null,
          applicationLimit: settings.applicationLimit,
          assignmentTargetShifts: settings.assignmentTargetShifts,
          assignmentMaxShifts: settings.assignmentMaxShifts,
          assignmentMaxMinutes: settings.assignmentMaxMinutes,
          withdrawalDeadlineHours: settings.withdrawalDeadlineHours,
        },
      })

      let created = 0
      if (body.copyFromWeekId) {
        const source = await tx.rosterWeek.findUnique({ where: { id: body.copyFromWeekId }, include: { slots: true } })
        if (!source) throw notFound('team:WEEK_NOT_FOUND')
        const shiftMs = toDate(body.weekStart).getTime() - source.weekStart.getTime()
        for (const slot of source.slots) {
          await tx.shiftSlot.create({
            data: {
              businessId,
              rosterWeekId: week.id,
              startsAt: new Date(slot.startsAt.getTime() + shiftMs),
              endsAt: new Date(slot.endsAt.getTime() + shiftMs),
              requiredStaff: slot.requiredStaff,
              canRunSolo: slot.canRunSolo,
              roleTags: slot.roleTags,
              workTypeId: slot.workTypeId,
              label: slot.label,
            },
          })
          created += 1
        }
      } else if (body.fromTemplate) {
        const [templates, hours, closed] = await Promise.all([
          tx.slotTemplate.findMany(),
          tx.operatingHours.findMany(),
          tx.closedPeriod.findMany({
            where: { endDate: { gte: toDate(body.weekStart) }, startDate: { lte: toDate(addDays(body.weekStart, 6)) } },
          }),
        ])
        const closedWeekdays = new Set(hours.filter((day) => day.isClosed).map((day) => day.weekday))
        for (const template of templates) {
          const date = addDays(body.weekStart, template.weekday)
          if (closedWeekdays.has(weekdayOf(date))) continue
          if (closed.some((period) => period.startDate.toISOString().slice(0, 10) <= date && date <= period.endDate.toISOString().slice(0, 10))) continue
          const { startsAt, endsAt } = shiftInstants(date, template.startTime, template.endTime)
          await tx.shiftSlot.create({
            data: {
              businessId,
              rosterWeekId: week.id,
              startsAt,
              endsAt,
              requiredStaff: template.requiredStaff,
              canRunSolo: template.canRunSolo,
              roleTags: template.roleTags,
              workTypeId: template.workTypeId,
              label: template.label,
            },
          })
          created += 1
        }
      }
      await audit(tx, businessId, actor, {
        action: 'roster.week_created',
        entityType: 'roster_week',
        entityId: week.id,
        after: { weekStart: body.weekStart, copiedFromWeekId: body.copyFromWeekId ?? null, shifts: created },
      })
      return week.id
    })
    return db.$transaction((tx) => weekDetail(tx, businessId, weekId))
  })

  app.get<{ Params: { id: string } }>('/rms/team/weeks/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    return request.db.$transaction((tx) => weekDetail(tx, request.businessId, id))
  })

  app.patch<{ Params: { id: string } }>('/rms/team/weeks/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const body = weekUpdate.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const before = await requireWeek(tx, id)
      const target = body.assignmentTargetShifts ?? before.assignmentTargetShifts
      if ((body.assignmentMaxShifts ?? before.assignmentMaxShifts) < target) throw badRequest('team:TARGET_ABOVE_MAX')
      const after = await tx.rosterWeek.update({
        where: { id },
        data: {
          ...body,
          applicationsOpenAt: instantOrNull(body.applicationsOpenAt),
          applicationsCloseAt: instantOrNull(body.applicationsCloseAt),
          reviewDeadline: instantOrNull(body.reviewDeadline),
          publishDeadline: instantOrNull(body.publishDeadline),
        },
      })
      await audit(tx, businessId, actor, {
        action: 'roster.week_settings_changed',
        entityType: 'roster_week',
        entityId: id,
        before: serialiseWeek(before),
        after: serialiseWeek(after),
      })
      return weekDetail(tx, businessId, id)
    })
  })

  /** Move a week through its stages. Publishing has its own route. */
  app.post<{ Params: { id: string } }>('/rms/team/weeks/:id/status', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { status } = statusBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const before = await requireWeek(tx, id)
      await tx.rosterWeek.update({
        where: { id },
        data: { status, ...(status === 'IN_REVIEW' ? { reviewedAt: new Date() } : {}) },
      })
      await audit(tx, businessId, actor, {
        action: before.status === 'PUBLISHED' ? 'roster.unpublished' : 'roster.status_changed',
        entityType: 'roster_week',
        entityId: id,
        before: { status: before.status },
        after: { status },
      })
      return weekDetail(tx, businessId, id)
    })
  })

  /**
   * Generate a suggested roster. Locked assignments stay exactly as they are;
   * every other assignment is replaced by the engine's suggestion. Refused on
   * a published week — changes there go through the coverage tools so staff
   * are never silently moved.
   */
  app.post<{ Params: { id: string } }>('/rms/team/weeks/:id/generate', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(
      async (tx) => {
        const week = await requireWeek(tx, id)
        if (week.status === 'PUBLISHED') throw conflict('team:WEEK_PUBLISHED')

        const replaced = await tx.assignment.findMany({
          where: { slot: { rosterWeekId: id }, status: 'ACTIVE', isLocked: false },
          select: { id: true, slotId: true, staffId: true, attendance: { select: { id: true } } },
        })
        const deletable = replaced.filter((assignment) => assignment.attendance.length === 0).map((assignment) => assignment.id)
        await tx.assignment.deleteMany({ where: { id: { in: deletable } } })
        await tx.assignment.updateMany({
          where: { id: { in: replaced.filter((assignment) => !deletable.includes(assignment.id)).map((assignment) => assignment.id) } },
          data: { status: 'REMOVED', endedAt: new Date() },
        })

        const fresh = await requireWeek(tx, id)
        const input = await engineInputFor(tx, businessId, fresh)
        // Inactive people keep any locked shift but are given nothing new.
        const active = new Set((await tx.staffMember.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map((s) => s.id))
        const result = generateRoster({ ...input, staff: input.staff.filter((staff) => active.has(staff.id)) })
        for (const suggestion of result.assignments) {
          await tx.assignment.create({
            data: {
              businessId,
              slotId: suggestion.slotId,
              staffId: suggestion.staffId,
              source: 'AUTO',
              explanation: suggestion.explanation,
            },
          })
        }
        await tx.rosterWeek.update({
          where: { id },
          data: { status: 'GENERATED', generatedAt: new Date(), version: { increment: 1 } },
        })
        await audit(tx, businessId, actor, {
          action: 'roster.generated',
          entityType: 'roster_week',
          entityId: id,
          before: { replaced: replaced.map(({ slotId, staffId }) => ({ slotId, staffId })) },
          after: { assignments: result.assignments.map(({ slotId, staffId }) => ({ slotId, staffId })), locked: input.locked.length },
        })
        return weekDetail(tx, businessId, id)
      },
      { timeout: 30_000 },
    )
  })

  /** Staff see their shifts from now on. The roster can still be changed. */
  app.post<{ Params: { id: string } }>('/rms/team/weeks/:id/publish', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const week = await requireWeek(tx, id)
      if (week.status === 'PUBLISHED') return weekDetail(tx, businessId, id)
      const input = await engineInputFor(tx, businessId, week)
      const { warnings } = evaluateRoster(input, activePlacements(week))
      await tx.rosterWeek.update({
        where: { id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), reviewedAt: week.reviewedAt ?? new Date(), version: { increment: 1 } },
      })
      await audit(tx, businessId, actor, {
        action: 'roster.published',
        entityType: 'roster_week',
        entityId: id,
        after: { assignments: activePlacements(week).length, warningsAtPublish: warnings.length },
      })
      return weekDetail(tx, businessId, id)
    })
  })

  /**
   * Give each shift to the staff who picked it, first come first served, until
   * it is full. Nobody is put on two shifts that overlap, and nobody already on
   * a shift is moved. Whoever is left over stays as a pick to place by hand.
   */
  app.post<{ Params: { id: string } }>('/rms/team/weeks/:id/fill-from-picks', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(
      async (tx) => {
        const week = await requireWeek(tx, id)
        if (week.status === 'PUBLISHED') throw conflict('team:WEEK_PUBLISHED')
        const active = new Set((await tx.staffMember.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map((s) => s.id))
        const placed = week.slots.flatMap((slot) =>
          slot.assignments
            .filter((assignment) => assignment.status === 'ACTIVE')
            .map((assignment) => ({ staffId: assignment.staffId, startsAt: slot.startsAt, endsAt: slot.endsAt })),
        )
        const added: Array<{ slotId: string; staffId: string }> = []
        let leftOver = 0
        for (const slot of week.slots) {
          let open = slot.requiredStaff - slot.assignments.filter((assignment) => assignment.status === 'ACTIVE').length
          const picks = slot.applications.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          for (const pick of picks) {
            if (slot.assignments.some((assignment) => assignment.staffId === pick.staffId && assignment.status === 'ACTIVE')) continue
            const busy = placed.some((p) => p.staffId === pick.staffId && p.startsAt < slot.endsAt && p.endsAt > slot.startsAt)
            if (open <= 0 || busy || !active.has(pick.staffId)) {
              leftOver += 1
              continue
            }
            await tx.assignment.create({ data: { businessId, slotId: slot.id, staffId: pick.staffId, source: 'MANUAL' } })
            placed.push({ staffId: pick.staffId, startsAt: slot.startsAt, endsAt: slot.endsAt })
            added.push({ slotId: slot.id, staffId: pick.staffId })
            open -= 1
          }
        }
        if (added.length > 0) await touchWeek(tx, id)
        await audit(tx, businessId, actor, {
          action: 'roster.filled_from_picks',
          entityType: 'roster_week',
          entityId: id,
          after: { added, leftOver },
        })
        return { added: added.length, leftOver, detail: await weekDetail(tx, businessId, id) }
      },
      { timeout: 30_000 },
    )
  })

  app.delete<{ Params: { id: string } }>('/rms/team/weeks/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    await db.$transaction(async (tx) => {
      const week = await requireWeek(tx, id)
      if (week.status === 'PUBLISHED') throw conflict('team:WEEK_PUBLISHED')
      const attended = await tx.attendanceRecord.count({ where: { assignment: { slot: { rosterWeekId: id } } } })
      if (attended > 0) throw conflict('team:HAS_ATTENDANCE')
      await tx.rosterWeek.delete({ where: { id } })
      await audit(tx, businessId, actor, { action: 'roster.week_deleted', entityType: 'roster_week', entityId: id, before: serialiseWeek(week) })
    })
    return { ok: true }
  })

  app.get<{ Params: { id: string } }>('/rms/team/weeks/:id/export', roster, async (request) => {
    const id = ID.parse(request.params.id)
    return request.db.$transaction((tx) => exportRoster(tx, request.businessId, id))
  })

  // -------------------------------------------------------------------------
  // Slots
  // -------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>('/rms/team/weeks/:id/slots', roster, async (request) => {
    const weekId = ID.parse(request.params.id)
    const body = slotBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const week = await requireWeek(tx, weekId)
      await assertWorkType(tx, body.workTypeId)
      const { startsAt, endsAt } = slotTimes(week.weekStart.toISOString().slice(0, 10), body)
      const slot = await tx.shiftSlot.create({
        data: {
          businessId,
          rosterWeekId: weekId,
          startsAt,
          endsAt,
          requiredStaff: body.requiredStaff,
          canRunSolo: body.canRunSolo,
          roleTags: body.roleTags,
          workTypeId: body.workTypeId ?? null,
          label: body.label ?? null,
        },
      })
      await touchWeek(tx, weekId)
      await audit(tx, businessId, actor, { action: 'roster.shift_added', entityType: 'shift', entityId: slot.id, after: body })
      return weekDetail(tx, businessId, weekId)
    })
  })

  app.patch<{ Params: { id: string } }>('/rms/team/slots/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const body = slotUpdate.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const before = await tx.shiftSlot.findUnique({ where: { id }, include: { rosterWeek: true } })
      if (!before) throw notFound('team:SHIFT_NOT_FOUND')
      await assertWorkType(tx, body.workTypeId)
      const times =
        body.date || body.startTime || body.endTime
          ? slotTimes(before.rosterWeek.weekStart.toISOString().slice(0, 10), {
              date: body.date ?? mytDate(before.startsAt),
              startTime: body.startTime ?? mytTime(before.startsAt),
              endTime: body.endTime ?? mytTime(before.endsAt),
            })
          : {}
      const { date: _date, startTime: _start, endTime: _end, ...rest } = body
      const after = await tx.shiftSlot.update({ where: { id }, data: { ...rest, ...times } })
      await touchWeek(tx, before.rosterWeekId)
      await audit(tx, businessId, actor, {
        action: 'roster.shift_changed',
        entityType: 'shift',
        entityId: id,
        before: { startsAt: before.startsAt, endsAt: before.endsAt, requiredStaff: before.requiredStaff },
        after: { startsAt: after.startsAt, endsAt: after.endsAt, requiredStaff: after.requiredStaff },
      })
      return weekDetail(tx, businessId, before.rosterWeekId)
    })
  })

  app.delete<{ Params: { id: string } }>('/rms/team/slots/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const slot = await tx.shiftSlot.findUnique({ where: { id } })
      if (!slot) throw notFound('team:SHIFT_NOT_FOUND')
      const attended = await tx.attendanceRecord.count({ where: { assignment: { slotId: id } } })
      if (attended > 0) throw conflict('team:HAS_ATTENDANCE')
      await tx.coverageRequest.deleteMany({ where: { slotId: id } })
      await tx.shiftSlot.delete({ where: { id } })
      await touchWeek(tx, slot.rosterWeekId)
      await audit(tx, businessId, actor, {
        action: 'roster.shift_removed',
        entityType: 'shift',
        entityId: id,
        before: { startsAt: slot.startsAt, endsAt: slot.endsAt },
      })
      return weekDetail(tx, businessId, slot.rosterWeekId)
    })
  })

  /**
   * Make one day's shifts the same as another day's in the week: that day's
   * shifts are replaced by copies (times, staff needed, label, work type — not
   * the people). Refused if anyone has hours recorded on a shift it would remove.
   */
  app.post<{ Params: { id: string; date: string } }>('/rms/team/weeks/:id/days/:date/copy-from', roster, async (request) => {
    const weekId = ID.parse(request.params.id)
    const date = DATE.parse(request.params.date)
    const { fromDate } = copyDayBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const week = await requireWeek(tx, weekId)
      const weekStart = week.weekStart.toISOString().slice(0, 10)
      const inWeek = (value: string) => value >= weekStart && value <= addDays(weekStart, 6)
      if (!inWeek(date) || !inWeek(fromDate)) throw badRequest('team:DATE_OUTSIDE_WEEK')
      if (date === fromDate) return weekDetail(tx, businessId, weekId)

      const targets = week.slots.filter((slot) => mytDate(slot.startsAt) === date)
      const attended = await tx.attendanceRecord.count({ where: { assignment: { slotId: { in: targets.map((slot) => slot.id) } } } })
      if (attended > 0) throw conflict('team:HAS_ATTENDANCE')
      await tx.coverageRequest.deleteMany({ where: { slotId: { in: targets.map((slot) => slot.id) } } })
      await tx.shiftSlot.deleteMany({ where: { id: { in: targets.map((slot) => slot.id) } } })

      const dayMs = Date.parse(`${date}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)
      const sources = week.slots.filter((slot) => mytDate(slot.startsAt) === fromDate)
      for (const slot of sources) {
        await tx.shiftSlot.create({
          data: {
            businessId,
            rosterWeekId: weekId,
            startsAt: new Date(slot.startsAt.getTime() + dayMs),
            endsAt: new Date(slot.endsAt.getTime() + dayMs),
            requiredStaff: slot.requiredStaff,
            canRunSolo: slot.canRunSolo,
            roleTags: slot.roleTags,
            workTypeId: slot.workTypeId,
            label: slot.label,
          },
        })
      }
      await touchWeek(tx, weekId)
      await audit(tx, businessId, actor, {
        action: 'roster.day_copied',
        entityType: 'roster_week',
        entityId: weekId,
        after: { fromDate, toDate: date, replaced: targets.length, copied: sources.length },
      })
      return weekDetail(tx, businessId, weekId)
    })
  })

  // -------------------------------------------------------------------------
  // Assignments — management's hand on the roster
  // -------------------------------------------------------------------------

  /**
   * Put someone on a shift. Warnings (not recommended on their own, a clash,
   * over their hours, did not apply…) come back for the screen to show; none
   * stops it. On a published shift with an open vacancy, this fills it as a
   * manager confirmation.
   */
  app.post<{ Params: { id: string } }>('/rms/team/slots/:id/assignments', roster, async (request) => {
    const slotId = ID.parse(request.params.id)
    const body = assignBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    return db.$transaction(async (tx) => {
      const slot = await tx.shiftSlot.findUnique({ where: { id: slotId }, include: { coverage: { where: { status: 'OPEN' } } } })
      if (!slot) throw notFound('team:SHIFT_NOT_FOUND')
      const staff = await tx.staffMember.findUnique({ where: { id: body.staffId } })
      if (!staff) throw notFound('team:STAFF_NOT_FOUND')
      if (staff.status !== 'ACTIVE') throw conflict('team:STAFF_INACTIVE')
      await assertWorkType(tx, body.workTypeId)
      if (await tx.assignment.findFirst({ where: { slotId, staffId: body.staffId, status: 'ACTIVE' } })) {
        throw conflict('team:ALREADY_ASSIGNED')
      }

      const week = await requireWeek(tx, slot.rosterWeekId)
      const input = await engineInputFor(tx, businessId, week)
      const withStaff = input.staff.some((member) => member.id === body.staffId)
        ? input
        : { ...input, staff: [...input.staff, ...(await loadEngineStaff(tx, [body.staffId])).filter((member) => member.id === body.staffId)] }
      const warnings = warningsForPlacement(withStaff, activePlacements(week), { slotId, staffId: body.staffId })

      const openVacancy = slot.coverage[0]
      let assignmentId: string
      if (openVacancy) {
        assignmentId = await fillCoverage(tx, businessId, actor, openVacancy.id, body.staffId, 'MANAGER_CONFIRMED', now)
        if (body.isLocked || body.workTypeId) {
          await tx.assignment.update({ where: { id: assignmentId }, data: { isLocked: body.isLocked, workTypeId: body.workTypeId ?? null } })
        }
      } else {
        const created = await tx.assignment.create({
          data: {
            businessId,
            slotId,
            staffId: body.staffId,
            source: 'MANUAL',
            isLocked: body.isLocked,
            workTypeId: body.workTypeId ?? null,
          },
        })
        assignmentId = created.id
        await touchWeek(tx, slot.rosterWeekId)
      }
      await audit(tx, businessId, actor, {
        action: warnings.length > 0 ? 'roster.assigned_over_warning' : 'roster.assigned',
        entityType: 'assignment',
        entityId: assignmentId,
        after: { slotId, staffId: body.staffId, isLocked: body.isLocked, warnings: warnings.map((warning) => warning.message) },
      })
      return { assignmentId, warnings, detail: await weekDetail(tx, businessId, slot.rosterWeekId) }
    })
  })

  /** Lock, change the work type, or set a one-off rate for this shift only. */
  app.patch<{ Params: { id: string } }>('/rms/team/assignments/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const body = assignmentUpdate.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    return db.$transaction(async (tx) => {
      const before = await tx.assignment.findUnique({ where: { id }, include: { slot: true, workType: true, staff: { include: { defaultWorkType: true } } } })
      if (!before) throw notFound('team:ASSIGNMENT_NOT_FOUND')
      await assertWorkType(tx, body.workTypeId)
      const rateChanged = body.rateOverrideSen !== undefined && body.rateOverrideSen !== before.rateOverrideSen
      const after = await tx.assignment.update({
        where: { id },
        data: {
          ...body,
          ...(rateChanged ? { rateOverrideAt: new Date() } : {}),
          ...(body.rateOverrideSen === null ? { rateOverrideReason: null, rateOverrideAt: null } : {}),
        },
      })
      await touchWeek(tx, before.slot.rosterWeekId)
      if (rateChanged) {
        await audit(tx, businessId, actor, {
          action: 'pay.rate_overridden',
          entityType: 'assignment',
          entityId: id,
          before: {
            rateOverrideSen: before.rateOverrideSen,
            defaultRateSen: (before.workType ?? before.staff.defaultWorkType)?.rateSenPerHour ?? null,
          },
          after: { rateOverrideSen: after.rateOverrideSen, reason: after.rateOverrideReason },
        })
      }
      if (body.isLocked !== undefined && body.isLocked !== before.isLocked) {
        await audit(tx, businessId, actor, { action: body.isLocked ? 'roster.locked' : 'roster.unlocked', entityType: 'assignment', entityId: id })
      }
      if (body.workTypeId !== undefined && body.workTypeId !== before.workTypeId) {
        await audit(tx, businessId, actor, {
          action: 'roster.work_type_changed',
          entityType: 'assignment',
          entityId: id,
          before: { workTypeId: before.workTypeId },
          after: { workTypeId: after.workTypeId },
        })
      }
      return weekDetail(tx, businessId, before.slot.rosterWeekId)
    })
  })

  /**
   * Take someone off a shift — management can, whatever the deadline. On a
   * published shift still to come, the seat becomes a vacancy and the
   * replacement queue starts (unless `vacancy=false`).
   */
  app.delete<{ Params: { id: string } }>('/rms/team/assignments/:id', roster, async (request) => {
    const id = ID.parse(request.params.id)
    const { vacancy } = removeQuery.parse(request.query)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    return db.$transaction(async (tx) => {
      const assignment = await tx.assignment.findUnique({
        where: { id },
        include: { slot: { include: { rosterWeek: true } }, attendance: { select: { id: true } } },
      })
      if (!assignment || assignment.status !== 'ACTIVE') throw notFound('team:ASSIGNMENT_NOT_FOUND')
      const published = assignment.slot.rosterWeek.status === 'PUBLISHED'
      if (!published && assignment.attendance.length === 0) {
        await tx.assignment.delete({ where: { id } })
      } else {
        await tx.assignment.update({ where: { id }, data: { status: 'REMOVED', endedAt: now } })
      }
      await touchWeek(tx, assignment.slot.rosterWeekId)
      await audit(tx, businessId, actor, {
        action: 'roster.manager_removed',
        entityType: 'assignment',
        entityId: id,
        before: { slotId: assignment.slotId, staffId: assignment.staffId },
      })
      if (published && vacancy === 'true' && assignment.slot.startsAt > now) {
        await openCoverage(tx, businessId, actor, assignment.slotId, id, now)
      }
      return weekDetail(tx, businessId, assignment.slot.rosterWeekId)
    })
  })

  // -------------------------------------------------------------------------
  // Coverage
  // -------------------------------------------------------------------------

  app.get('/rms/team/coverage', coverage, async (request) => {
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      const requests = await tx.coverageRequest.findMany({
        where: {
          OR: [
            { status: 'OPEN' },
            { resolvedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
          ],
        },
        orderBy: [{ status: 'asc' }, { isUrgent: 'desc' }, { createdAt: 'asc' }],
        include: {
          slot: true,
          vacatedAssignment: { select: { staff: { select: { name: true } }, status: true } },
          offers: { orderBy: { rank: 'asc' }, include: { staff: { select: { name: true } } } },
        },
      })
      const urgentMs = (await teamSettingsFor(tx, businessId)).urgentCoverageHours * 3_600_000
      const staffNames = new Map(
        (await tx.staffMember.findMany({ select: { id: true, name: true } })).map((staff) => [staff.id, staff.name]),
      )
      const out = []
      for (const item of requests) {
        const queue = item.status === 'OPEN' ? await replacementQueue(tx, businessId, item.id) : []
        out.push({
          id: item.id,
          status: item.status,
          // Re-judged against the clock: a vacancy can become urgent while it waits.
          isUrgent: item.isUrgent || (item.status === 'OPEN' && item.slot.startsAt.getTime() - Date.now() <= urgentMs),
          createdAt: item.createdAt.toISOString(),
          resolvedAt: item.resolvedAt?.toISOString() ?? null,
          slot: {
            id: item.slot.id,
            weekId: item.slot.rosterWeekId,
            date: mytDate(item.slot.startsAt),
            startTime: mytTime(item.slot.startsAt),
            endTime: mytTime(item.slot.endsAt),
            startsAt: item.slot.startsAt.toISOString(),
            label: item.slot.label,
          },
          vacatedBy: item.vacatedAssignment?.staff.name ?? null,
          vacatedHow: item.vacatedAssignment?.status ?? null,
          offers: item.offers.map((offer) => ({
            id: offer.id,
            staffId: offer.staffId,
            staffName: offer.staff.name,
            rank: offer.rank,
            status: offer.status,
            respondedAt: offer.respondedAt?.toISOString() ?? null,
          })),
          queue: queue.slice(0, 10).map((candidate) => Object.assign(candidate, { staffName: staffNames.get(candidate.staffId) ?? '' })),
        })
      }
      return { coverage: out }
    })
  })

  /** "Aina said she can cover" — confirmed on her behalf, recorded as such. */
  app.post<{ Params: { id: string } }>('/rms/team/coverage/:id/confirm', coverage, async (request) => {
    const id = ID.parse(request.params.id)
    const { staffId } = confirmBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const item = await tx.coverageRequest.findUnique({ where: { id } })
      if (!item) throw notFound('team:COVERAGE_NOT_FOUND')
      if (item.status !== 'OPEN') throw conflict('team:COVERAGE_CLOSED')
      const staff = await tx.staffMember.findUnique({ where: { id: staffId } })
      if (!staff || staff.status !== 'ACTIVE') throw conflict('team:STAFF_INACTIVE')
      if (await tx.assignment.findFirst({ where: { slotId: item.slotId, staffId, status: 'ACTIVE' } })) {
        throw conflict('team:ALREADY_ASSIGNED')
      }
      await fillCoverage(tx, businessId, actor, id, staffId, 'MANAGER_CONFIRMED', now)
    })
    return { ok: true }
  })

  /** Pass over whoever has the offer now, and offer it to the next person. */
  app.post<{ Params: { id: string } }>('/rms/team/coverage/:id/skip', coverage, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const item = await tx.coverageRequest.findUnique({ where: { id }, include: { offers: { where: { status: 'PENDING' } } } })
      if (!item) throw notFound('team:COVERAGE_NOT_FOUND')
      if (item.status !== 'OPEN') throw conflict('team:COVERAGE_CLOSED')
      for (const offer of item.offers) {
        await tx.replacementOffer.update({ where: { id: offer.id }, data: { status: 'MANAGER_SKIPPED', respondedAt: now } })
        await audit(tx, businessId, actor, { action: 'coverage.skipped_by_manager', entityType: 'coverage', entityId: id, after: { staffId: offer.staffId } })
      }
      await offerNext(tx, businessId, id, now)
    })
    return { ok: true }
  })

  /** Try the queue again — after new staff were added, or the queue was empty. */
  app.post<{ Params: { id: string } }>('/rms/team/coverage/:id/offer-next', coverage, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const offerId = await db.$transaction((tx) => offerNext(tx, businessId, id, new Date()))
    return { offerId }
  })

  app.post<{ Params: { id: string } }>('/rms/team/coverage/:id/cancel', coverage, async (request) => {
    const id = ID.parse(request.params.id)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const now = new Date()
    await db.$transaction(async (tx) => {
      const closed = await tx.coverageRequest.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CANCELLED', resolvedAt: now } })
      if (closed.count === 0) throw conflict('team:COVERAGE_CLOSED')
      await tx.replacementOffer.updateMany({ where: { coverageRequestId: id, status: 'PENDING' }, data: { status: 'SUPERSEDED', respondedAt: now } })
      await audit(tx, businessId, actor, { action: 'coverage.cancelled', entityType: 'coverage', entityId: id })
    })
    return { ok: true }
  })
}
