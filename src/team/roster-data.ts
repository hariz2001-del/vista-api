import type { Tx } from '../db.ts'
import {
  weightsFrom,
  type EngineInput,
  type EngineSlot,
  type EngineStaff,
  type Placement,
} from '../domain/rostering.ts'

/**
 * A roster week loaded the way the engine and the screens need it. Runs inside
 * the caller's (business-scoped) transaction.
 */
export async function loadWeek(tx: Tx, weekId: string) {
  const week = await tx.rosterWeek.findUnique({
    where: { id: weekId },
    include: {
      slots: {
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        include: {
          workType: true,
          applications: { where: { status: 'APPLIED' }, select: { staffId: true, createdAt: true } },
          assignments: {
            orderBy: { createdAt: 'asc' },
            include: { workType: true, staff: { select: { id: true, name: true, staffCode: true } } },
          },
          coverage: { where: { status: 'OPEN' }, select: { id: true, isUrgent: true } },
        },
      },
    },
  })
  return week
}

export type LoadedWeek = NonNullable<Awaited<ReturnType<typeof loadWeek>>>

/** Everyone the engine should consider: active staff, with their confidential attributes. */
export async function loadEngineStaff(tx: Tx, alsoInclude: string[] = []): Promise<EngineStaff[]> {
  const staff = await tx.staffMember.findMany({
    where: { OR: [{ status: 'ACTIVE' }, { id: { in: alsoInclude } }] },
    orderBy: { name: 'asc' },
    include: { attributes: true },
  })
  return staff.map((member) => ({
    id: member.id,
    name: member.name,
    roleTags: member.roleTags,
    attributes: member.attributes
      ? {
          reliability: member.attributes.reliability,
          capability: member.attributes.capability,
          experience: member.attributes.experience,
          soloSuitability: member.attributes.soloSuitability,
          trainingStatus: member.attributes.trainingStatus,
          managementPriority: member.attributes.managementPriority,
        }
      : null,
  }))
}

export function engineSlots(week: LoadedWeek): EngineSlot[] {
  return week.slots.map((slot) => ({
    id: slot.id,
    startsAt: slot.startsAt.getTime(),
    endsAt: slot.endsAt.getTime(),
    requiredStaff: slot.requiredStaff,
    canRunSolo: slot.canRunSolo,
    roleTags: slot.roleTags,
  }))
}

export function activePlacements(week: LoadedWeek): Array<Placement & { isLocked: boolean; id: string }> {
  return week.slots.flatMap((slot) =>
    slot.assignments
      .filter((assignment) => assignment.status === 'ACTIVE')
      .map((assignment) => ({ id: assignment.id, slotId: slot.id, staffId: assignment.staffId, isLocked: assignment.isLocked })),
  )
}

/** The engine's whole input for a week. */
export async function engineInputFor(tx: Tx, businessId: string, week: LoadedWeek): Promise<EngineInput> {
  const placements = activePlacements(week)
  const staff = await loadEngineStaff(tx, placements.map((placement) => placement.staffId))
  const settings = await tx.teamSettings.findUnique({ where: { businessId } })
  return {
    staff,
    slots: engineSlots(week),
    applications: new Map(
      week.slots.map((slot) => [slot.id, new Set(slot.applications.map((application) => application.staffId))]),
    ),
    locked: placements.filter((placement) => placement.isLocked),
    limits: {
      targetShifts: week.assignmentTargetShifts,
      maxShifts: week.assignmentMaxShifts,
      maxMinutes: week.assignmentMaxMinutes,
    },
    weights: weightsFrom(settings?.engineWeights),
  }
}

/** Bump a week's version so exports and staff screens can tell it changed. */
export async function touchWeek(tx: Tx, weekId: string): Promise<void> {
  await tx.rosterWeek.update({ where: { id: weekId }, data: { version: { increment: 1 } } })
}

/**
 * Where a week stands. Active and Completed are read from the clock rather
 * than stored, so nothing has to run at midnight to move them on.
 */
export function weekPhase(week: { status: string; weekStart: Date }, now: Date): string {
  if (week.status !== 'PUBLISHED') return week.status
  const start = week.weekStart.getTime() - 8 * 3_600_000
  const end = start + 7 * 86_400_000
  if (now.getTime() >= end) return 'COMPLETED'
  if (now.getTime() >= start) return 'ACTIVE'
  return 'PUBLISHED'
}
