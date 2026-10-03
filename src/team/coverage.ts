import type { Tx } from '../db.ts'
import { rankReplacements } from '../domain/rostering.ts'
import { audit, SYSTEM_ACTOR, type Actor } from './audit.ts'
import { engineInputFor, loadWeek, touchWeek } from './roster-data.ts'

/**
 * Covering a seat that came free on a published roster.
 *
 * Offers go out one at a time, in the replacement queue's order. Nobody is
 * ever put on a shift without saying yes — in the app, or to a manager who
 * then confirms it for them. Inside the urgent window the vacancy is flagged
 * so it sits at the top of the RMS.
 */

/** Open a vacancy for a seat and offer it to the first person in the queue. */
export async function openCoverage(
  tx: Tx,
  businessId: string,
  actor: Actor,
  slotId: string,
  vacatedAssignmentId: string | null,
  now: Date,
): Promise<string> {
  const slot = await tx.shiftSlot.findUniqueOrThrow({ where: { id: slotId } })
  const settings = await tx.teamSettings.findUnique({ where: { businessId } })
  const urgentMs = (settings?.urgentCoverageHours ?? 24) * 3_600_000
  const isUrgent = slot.startsAt.getTime() - now.getTime() <= urgentMs

  const request = await tx.coverageRequest.create({
    data: { businessId, slotId, vacatedAssignmentId, isUrgent },
  })
  await audit(tx, businessId, actor, {
    action: isUrgent ? 'coverage.opened_urgent' : 'coverage.opened',
    entityType: 'coverage',
    entityId: request.id,
    after: { slotId, vacatedAssignmentId, isUrgent },
  })
  await offerNext(tx, businessId, request.id, now)
  return request.id
}

/**
 * The replacement queue for a vacancy, best first. Leaves out whoever already
 * had an offer for it and whoever vacated the seat.
 */
export async function replacementQueue(tx: Tx, businessId: string, coverageId: string) {
  const request = await tx.coverageRequest.findUniqueOrThrow({
    where: { id: coverageId },
    include: {
      offers: { select: { staffId: true } },
      vacatedAssignment: { select: { staffId: true } },
      slot: { select: { rosterWeekId: true, id: true } },
    },
  })
  const week = await loadWeek(tx, request.slot.rosterWeekId)
  if (!week) return []
  const input = await engineInputFor(tx, businessId, week)
  const exclude = new Set(request.offers.map((offer) => offer.staffId))
  if (request.vacatedAssignment) exclude.add(request.vacatedAssignment.staffId)
  // Only active staff can be offered anything.
  const active = await tx.staffMember.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  const activeIds = new Set(active.map((staff) => staff.id))
  const placements = week.slots.flatMap((slot) =>
    slot.assignments
      .filter((assignment) => assignment.status === 'ACTIVE')
      .map((assignment) => ({ slotId: slot.id, staffId: assignment.staffId })),
  )
  return rankReplacements(
    { ...input, staff: input.staff.filter((staff) => activeIds.has(staff.id)) },
    placements,
    request.slot.id,
    exclude,
  )
}

/**
 * Offer the vacancy to the next person in the queue. Does nothing if an offer
 * is already waiting or the vacancy is no longer open; if the queue is empty,
 * the vacancy simply waits for management.
 */
export async function offerNext(tx: Tx, businessId: string, coverageId: string, now: Date): Promise<string | null> {
  const request = await tx.coverageRequest.findUniqueOrThrow({
    where: { id: coverageId },
    include: { offers: true, slot: true },
  })
  if (request.status !== 'OPEN') return null
  if (request.offers.some((offer) => offer.status === 'PENDING')) return null
  // A shift that has already started is management's to sort out by hand.
  if (request.slot.startsAt <= now) return null

  const queue = await replacementQueue(tx, businessId, coverageId)
  const next = queue[0]
  if (!next) return null

  const offer = await tx.replacementOffer.create({
    data: {
      businessId,
      coverageRequestId: coverageId,
      staffId: next.staffId,
      rank: request.offers.length + 1,
    },
  })
  await audit(tx, businessId, SYSTEM_ACTOR, {
    action: 'coverage.offered',
    entityType: 'coverage',
    entityId: coverageId,
    after: { offerId: offer.id, staffId: next.staffId, rank: offer.rank },
  })
  return offer.id
}

/**
 * Put someone on the vacated seat and close the vacancy. Any other waiting
 * offer is superseded. `how` is recorded as it happened: the staff member
 * accepting in the app is not the same as a manager confirming for them.
 */
export async function fillCoverage(
  tx: Tx,
  businessId: string,
  actor: Actor,
  coverageId: string,
  staffId: string,
  how: 'ACCEPTED' | 'MANAGER_CONFIRMED',
  now: Date,
): Promise<string> {
  const request = await tx.coverageRequest.findUniqueOrThrow({
    where: { id: coverageId },
    include: { slot: true, offers: true },
  })
  const assignment = await tx.assignment.create({
    data: { businessId, slotId: request.slotId, staffId, source: 'REPLACEMENT' },
  })
  const filled = await tx.coverageRequest.updateMany({
    where: { id: coverageId, status: 'OPEN' },
    data: { status: 'FILLED', resolvedAt: now },
  })
  if (filled.count !== 1) throw new Error('coverage no longer open')

  const ownOffer = request.offers.find((offer) => offer.staffId === staffId)
  if (ownOffer) {
    await tx.replacementOffer.update({
      where: { id: ownOffer.id },
      data: { status: how, respondedAt: now },
    })
  } else {
    // Confirmed by a manager without an offer having gone to them first.
    await tx.replacementOffer.create({
      data: {
        businessId,
        coverageRequestId: coverageId,
        staffId,
        rank: request.offers.length + 1,
        status: 'MANAGER_CONFIRMED',
        respondedAt: now,
      },
    })
  }
  await tx.replacementOffer.updateMany({
    where: { coverageRequestId: coverageId, status: 'PENDING', staffId: { not: staffId } },
    data: { status: 'SUPERSEDED', respondedAt: now },
  })
  await touchWeek(tx, request.slot.rosterWeekId)
  await audit(tx, businessId, actor, {
    action: how === 'ACCEPTED' ? 'coverage.accepted_by_staff' : 'coverage.confirmed_by_manager',
    entityType: 'coverage',
    entityId: coverageId,
    after: { staffId, assignmentId: assignment.id },
  })
  return assignment.id
}
