/**
 * The rostering engine: a deterministic suggestion of who works which shift.
 *
 * Pure functions over plain data — no database, no clock, no randomness — so
 * the same applications always give the same roster, every decision can be
 * explained, and the tests can pin it exactly. Management can override
 * anything it produces; nothing here is a rule, only a recommendation.
 *
 * Two passes:
 *  1. Fair share. The open hours are divided among the people who applied,
 *     nudged by how much each applied for. Repeatedly, whoever is furthest
 *     below their share gets their scarcest feasible applied shift. This is
 *     what stops the best-rated person taking every shift.
 *  2. Fill. Seats still open are filled, scarcest first, by the best-scoring
 *     feasible applicant.
 *
 * Locked assignments are fixed before either pass and never moved.
 */

export type SoloSuitability = 'SUITABLE' | 'CAUTION' | 'NOT_RECOMMENDED'
export type TrainingStatus = 'TRAINEE' | 'TRAINED'

export type EngineStaff = {
  id: string
  name: string
  roleTags: string[]
  /** Confidential. Null when management has not assessed them. */
  attributes: {
    reliability: number | null
    capability: number | null
    experience: number | null
    soloSuitability: SoloSuitability
    trainingStatus: TrainingStatus
    managementPriority: number
  } | null
}

export type EngineSlot = {
  id: string
  startsAt: number
  endsAt: number
  requiredStaff: number
  canRunSolo: boolean
  roleTags: string[]
}

export type EngineLimits = {
  targetShifts: number
  maxShifts: number
  maxMinutes: number
}

export type EngineWeights = {
  /** How much applying for more hours raises someone's fair share (0 = not at all). */
  availability: number
  /** Pull towards whoever is furthest below their fair share. */
  fairness: number
  reliability: number
  capability: number
  experience: number
  priority: number
  /** Penalty for leaving a not-recommended person on a shift alone. */
  soloRisk: number
  /** Penalty for a trainee with no trained colleague on the shift. */
  traineeAlone: number
  /** Penalty per shift above the usual number. */
  overTarget: number
}

export const DEFAULT_WEIGHTS: EngineWeights = {
  availability: 0.5,
  fairness: 10,
  reliability: 1,
  capability: 1,
  experience: 0.5,
  priority: 1.5,
  soloRisk: 6,
  traineeAlone: 4,
  overTarget: 3,
}

export function weightsFrom(stored: unknown): EngineWeights {
  const weights = { ...DEFAULT_WEIGHTS }
  if (stored && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      if (key in weights && typeof value === 'number' && Number.isFinite(value)) {
        weights[key as keyof EngineWeights] = value
      }
    }
  }
  return weights
}

export type Placement = { slotId: string; staffId: string }

export type EngineInput = {
  staff: EngineStaff[]
  slots: EngineSlot[]
  /** slotId → staff ids who applied (and have not withdrawn the application). */
  applications: Map<string, Set<string>>
  /** Assignments the engine must keep exactly as they are. */
  locked: Placement[]
  limits: EngineLimits
  weights: EngineWeights
}

export type EngineAssignment = Placement & { explanation: string }

export type Warning = {
  kind:
    | 'UNFILLED'
    | 'OVERSTAFFED'
    | 'SOLO_NOT_RECOMMENDED'
    | 'SOLO_CAUTION'
    | 'SOLO_SLOT'
    | 'TRAINEE_ALONE'
    | 'OVER_TARGET'
    | 'OVER_MAX_SHIFTS'
    | 'OVER_MAX_HOURS'
    | 'OVERLAP'
    | 'MISSING_ROLE'
    | 'DID_NOT_APPLY'
  slotId: string | null
  staffId: string | null
  message: string
}

export type StaffFairness = {
  staffId: string
  appliedShifts: number
  appliedMinutes: number
  assignedShifts: number
  assignedMinutes: number
  fairShareMinutes: number
  /** Assigned ÷ applied shifts, 0–1. Null when they applied for nothing. */
  fillRate: number | null
}

/** A 1–5 score around its middle, so "not assessed" counts as average. */
const centred = (value: number | null | undefined) => (value == null ? 0 : value - 3)
const warningKey = (warning: Warning) => `${warning.kind}|${warning.slotId}|${warning.staffId}`
const minutesOf = (slot: EngineSlot) => Math.round((slot.endsAt - slot.startsAt) / 60_000)
const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10}h`

/** A stable tie-break that does not favour alphabetical order or creation order. */
function stableHash(text: string): number {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

type State = {
  bySlot: Map<string, string[]>
  minutes: Map<string, number>
  shifts: Map<string, number>
  intervals: Map<string, Array<{ start: number; end: number }>>
}

function emptyState(): State {
  return { bySlot: new Map(), minutes: new Map(), shifts: new Map(), intervals: new Map() }
}

function place(state: State, slot: EngineSlot, staffId: string): void {
  state.bySlot.set(slot.id, [...(state.bySlot.get(slot.id) ?? []), staffId])
  state.minutes.set(staffId, (state.minutes.get(staffId) ?? 0) + minutesOf(slot))
  state.shifts.set(staffId, (state.shifts.get(staffId) ?? 0) + 1)
  state.intervals.set(staffId, [...(state.intervals.get(staffId) ?? []), { start: slot.startsAt, end: slot.endsAt }])
}

function hasRole(staff: EngineStaff, slot: EngineSlot): boolean {
  if (slot.roleTags.length === 0) return true
  return slot.roleTags.some((tag) => staff.roleTags.includes(tag))
}

/** Hard limits the engine will not break by itself. Management still can. */
function feasible(state: State, input: EngineInput, slot: EngineSlot, staff: EngineStaff): boolean {
  const assigned = state.bySlot.get(slot.id) ?? []
  if (assigned.includes(staff.id)) return false
  if (assigned.length >= slot.requiredStaff) return false
  if (!hasRole(staff, slot)) return false
  if ((state.shifts.get(staff.id) ?? 0) + 1 > input.limits.maxShifts) return false
  if ((state.minutes.get(staff.id) ?? 0) + minutesOf(slot) > input.limits.maxMinutes) return false
  const interval = { start: slot.startsAt, end: slot.endsAt }
  return !(state.intervals.get(staff.id) ?? []).some((other) => other.start < interval.end && interval.start < other.end)
}

/** Would this person end up alone on the shift? */
function wouldBeSolo(slot: EngineSlot): boolean {
  return slot.requiredStaff === 1
}

/**
 * How suitable a person is for a seat, before fairness. Higher is better.
 * Returns the parts too, for the explanation.
 */
function suitability(
  state: State,
  input: EngineInput,
  slot: EngineSlot,
  staff: EngineStaff,
): { score: number; reasons: string[] } {
  const { weights } = input
  const attributes = staff.attributes
  const reasons: string[] = []
  let score = 0

  score += weights.reliability * centred(attributes?.reliability)
  score += weights.capability * centred(attributes?.capability)
  score += weights.experience * centred(attributes?.experience)
  score += weights.priority * (attributes?.managementPriority ?? 0)
  if ((attributes?.reliability ?? 0) >= 4) reasons.push('reliable')
  if ((attributes?.managementPriority ?? 0) > 0) reasons.push('management priority')

  if (wouldBeSolo(slot)) {
    const solo = attributes?.soloSuitability ?? 'SUITABLE'
    if (solo === 'NOT_RECOMMENDED') score -= weights.soloRisk
    else if (solo === 'CAUTION') score -= weights.soloRisk / 2
    else reasons.push('suitable on their own')
  }

  if (attributes?.trainingStatus === 'TRAINEE') {
    const others = (state.bySlot.get(slot.id) ?? [])
      .map((id) => input.staff.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is EngineStaff => Boolean(candidate))
    const hasTrained = others.some((other) => other.attributes?.trainingStatus !== 'TRAINEE')
    const seatsLeftAfter = slot.requiredStaff - others.length - 1
    if (!hasTrained && seatsLeftAfter === 0) score -= weights.traineeAlone
    else if (hasTrained) reasons.push('trainee with a trained colleague')
  }

  const shifts = state.shifts.get(staff.id) ?? 0
  if (shifts + 1 > input.limits.targetShifts) score -= weights.overTarget * (shifts + 1 - input.limits.targetShifts)

  return { score, reasons }
}

/** Each applicant's fair share of the open hours. */
function fairShares(input: EngineInput, state: State): Map<string, number> {
  const appliedMinutes = new Map<string, number>()
  let openMinutes = 0
  for (const slot of input.slots) {
    const applicants = input.applications.get(slot.id)
    if (!applicants || applicants.size === 0) continue
    const seatsOpen = Math.max(0, slot.requiredStaff - (state.bySlot.get(slot.id)?.length ?? 0))
    openMinutes += seatsOpen * minutesOf(slot)
    for (const staffId of applicants) {
      appliedMinutes.set(staffId, (appliedMinutes.get(staffId) ?? 0) + minutesOf(slot))
    }
  }
  // Locked minutes count towards a person's share: they already have them.
  for (const minutes of state.minutes.values()) openMinutes += minutes

  const ids = [...appliedMinutes.keys()]
  if (ids.length === 0) return new Map()
  const average = ids.reduce((sum, id) => sum + (appliedMinutes.get(id) ?? 0), 0) / ids.length
  const weightOf = (id: string) =>
    Math.max(0.2, 1 + input.weights.availability * ((appliedMinutes.get(id) ?? 0) / average - 1))
  const totalWeight = ids.reduce((sum, id) => sum + weightOf(id), 0)

  const shares = new Map<string, number>()
  for (const id of ids) {
    const share = (openMinutes * weightOf(id)) / totalWeight
    shares.set(id, Math.min(share, appliedMinutes.get(id) ?? 0, input.limits.maxMinutes))
  }
  return shares
}

/**
 * How short of the open seats a slot is likely to run: applicants who could
 * still take it, per seat still open. Lower is scarcer and is staffed first.
 */
function scarcity(state: State, input: EngineInput, slot: EngineSlot, staffById: Map<string, EngineStaff>): number {
  const open = slot.requiredStaff - (state.bySlot.get(slot.id)?.length ?? 0)
  if (open <= 0) return Number.POSITIVE_INFINITY
  let possible = 0
  for (const staffId of input.applications.get(slot.id) ?? []) {
    const staff = staffById.get(staffId)
    if (staff && feasible(state, input, slot, staff)) possible += 1
  }
  return possible / open
}

function explain(
  slot: EngineSlot,
  staff: EngineStaff,
  state: State,
  share: number | undefined,
  reasons: string[],
  input: EngineInput,
): string {
  const parts = ['Applied for this shift']
  const before = (state.minutes.get(staff.id) ?? 0) - minutesOf(slot)
  if (share !== undefined && share - before > 0) parts.push(`${hours(share - before)} below fair share`)
  const applicants = input.applications.get(slot.id)?.size ?? 0
  if (applicants === 1) parts.push('only applicant')
  parts.push(...reasons)
  return parts.join(' · ')
}

export type EngineResult = {
  assignments: EngineAssignment[]
  fairShares: Map<string, number>
}

export function generateRoster(input: EngineInput): EngineResult {
  const state = emptyState()
  const slotById = new Map(input.slots.map((slot) => [slot.id, slot]))
  const staffById = new Map(input.staff.map((staff) => [staff.id, staff]))

  for (const lock of input.locked) {
    const slot = slotById.get(lock.slotId)
    if (slot) place(state, slot, lock.staffId)
  }

  const shares = fairShares(input, state)
  const assignments: EngineAssignment[] = []
  const tieBreak = (id: string) => stableHash(`${input.slots[0]?.startsAt ?? 0}:${id}`)

  const appliedOpenSlots = (staff: EngineStaff) =>
    input.slots.filter(
      (slot) => input.applications.get(slot.id)?.has(staff.id) && feasible(state, input, slot, staff),
    )

  // Pass 1 — fair share.
  for (let guard = 0; guard < 10_000; guard += 1) {
    let pick: { staff: EngineStaff; deficit: number } | null = null
    for (const staff of input.staff) {
      const share = shares.get(staff.id)
      if (!share) continue
      const deficit = (share - (state.minutes.get(staff.id) ?? 0)) / share
      if (deficit <= 0 || appliedOpenSlots(staff).length === 0) continue
      if (
        !pick ||
        deficit > pick.deficit + 1e-9 ||
        (Math.abs(deficit - pick.deficit) <= 1e-9 && tieBreak(staff.id) < tieBreak(pick.staff.id))
      ) {
        pick = { staff, deficit }
      }
    }
    if (!pick) break

    const staff = pick.staff
    const options = appliedOpenSlots(staff)
      .map((slot) => ({ slot, fit: suitability(state, input, slot, staff), scarce: scarcity(state, input, slot, staffById) }))
      // Do not make someone the risky choice when they are not the only option.
      .toSorted(
        (a, b) =>
          a.scarce - b.scarce ||
          b.fit.score - a.fit.score ||
          a.slot.startsAt - b.slot.startsAt ||
          a.slot.id.localeCompare(b.slot.id),
      )
    const best = options.find((option) => option.fit.score > -input.weights.soloRisk + 1e-9) ?? null
    if (!best) {
      // Every shift they could take would be a poor fit; leave them to the fill pass.
      shares.set(staff.id, state.minutes.get(staff.id) ?? 0)
      continue
    }
    place(state, best.slot, staff.id)
    assignments.push({
      slotId: best.slot.id,
      staffId: staff.id,
      explanation: explain(best.slot, staff, state, shares.get(staff.id), best.fit.reasons, input),
    })
  }

  // Pass 2 — fill what is left, scarcest seats first, best overall candidate.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const open = input.slots
      .map((slot) => ({ slot, scarce: scarcity(state, input, slot, staffById) }))
      .filter((entry) => Number.isFinite(entry.scarce) && entry.scarce > 0)
      .toSorted((a, b) => a.scarce - b.scarce || a.slot.startsAt - b.slot.startsAt || a.slot.id.localeCompare(b.slot.id))
    const target = open[0]
    if (!target) break

    const slot = target.slot
    const candidates = [...(input.applications.get(slot.id) ?? [])]
      .map((id) => staffById.get(id))
      .filter((staff): staff is EngineStaff => Boolean(staff) && feasible(state, input, slot, staff as EngineStaff))
      .map((staff) => {
        const fit = suitability(state, input, slot, staff)
        const share = shares.get(staff.id) ?? 0
        const deficitHours = (share - (state.minutes.get(staff.id) ?? 0)) / 60
        return { staff, fit, total: fit.score + (input.weights.fairness * deficitHours) / Math.max(1, minutesOf(slot) / 60) }
      })
      .toSorted((a, b) => b.total - a.total || (state.minutes.get(a.staff.id) ?? 0) - (state.minutes.get(b.staff.id) ?? 0) || tieBreak(a.staff.id) - tieBreak(b.staff.id))
    const best = candidates[0]
    if (!best) break
    place(state, slot, best.staff.id)
    assignments.push({
      slotId: slot.id,
      staffId: best.staff.id,
      explanation: explain(slot, best.staff, state, shares.get(best.staff.id), best.fit.reasons, input),
    })
  }

  return { assignments, fairShares: fairShares(input, emptyStateWith(input.locked, slotById)) }
}

function emptyStateWith(locked: Placement[], slotById: Map<string, EngineSlot>): State {
  const state = emptyState()
  for (const lock of locked) {
    const slot = slotById.get(lock.slotId)
    if (slot) place(state, slot, lock.staffId)
  }
  return state
}

/**
 * Warnings and fairness for a roster as it stands — the engine's suggestion,
 * or whatever management has made of it. Informs; never blocks.
 */
export function evaluateRoster(
  input: Omit<EngineInput, 'locked'>,
  placements: Placement[],
): { warnings: Warning[]; fairness: StaffFairness[] } {
  const slotById = new Map(input.slots.map((slot) => [slot.id, slot]))
  const staffById = new Map(input.staff.map((staff) => [staff.id, staff]))
  const state = emptyState()
  const warnings: Warning[] = []
  const name = (id: string) => staffById.get(id)?.name ?? 'Someone'

  for (const placement of placements.toSorted((a, b) => (slotById.get(a.slotId)?.startsAt ?? 0) - (slotById.get(b.slotId)?.startsAt ?? 0))) {
    const slot = slotById.get(placement.slotId)
    if (!slot) continue
    const interval = { start: slot.startsAt, end: slot.endsAt }
    const clash = (state.intervals.get(placement.staffId) ?? []).some(
      (other) => other.start < interval.end && interval.start < other.end,
    )
    if (clash) {
      warnings.push({ kind: 'OVERLAP', slotId: slot.id, staffId: placement.staffId, message: `${name(placement.staffId)} is on two shifts at once.` })
    }
    place(state, slot, placement.staffId)
  }

  for (const slot of input.slots) {
    const assigned = state.bySlot.get(slot.id) ?? []
    if (assigned.length < slot.requiredStaff) {
      const missing = slot.requiredStaff - assigned.length
      warnings.push({ kind: 'UNFILLED', slotId: slot.id, staffId: null, message: `${missing} seat${missing === 1 ? '' : 's'} not filled.` })
    }
    if (assigned.length > slot.requiredStaff) {
      warnings.push({ kind: 'OVERSTAFFED', slotId: slot.id, staffId: null, message: `${assigned.length - slot.requiredStaff} more than needed.` })
    }
    if (assigned.length === 1) {
      const only = assigned[0] as string
      if (!slot.canRunSolo) {
        warnings.push({ kind: 'SOLO_SLOT', slotId: slot.id, staffId: only, message: 'This shift should not run with one person.' })
      }
      const solo = staffById.get(only)?.attributes?.soloSuitability
      if (solo === 'NOT_RECOMMENDED') {
        warnings.push({ kind: 'SOLO_NOT_RECOMMENDED', slotId: slot.id, staffId: only, message: `${name(only)} is marked “Not recommended on their own”.` })
      } else if (solo === 'CAUTION') {
        warnings.push({ kind: 'SOLO_CAUTION', slotId: slot.id, staffId: only, message: `${name(only)} is marked “Use caution on their own”.` })
      }
    }
    if (assigned.length > 0 && assigned.every((id) => staffById.get(id)?.attributes?.trainingStatus === 'TRAINEE')) {
      warnings.push({ kind: 'TRAINEE_ALONE', slotId: slot.id, staffId: null, message: 'Only trainees on this shift.' })
    }
    for (const staffId of assigned) {
      const staff = staffById.get(staffId)
      if (staff && !hasRole(staff, slot)) {
        warnings.push({ kind: 'MISSING_ROLE', slotId: slot.id, staffId, message: `${staff.name} does not have the role this shift needs (${slot.roleTags.join(', ')}).` })
      }
      if (!input.applications.get(slot.id)?.has(staffId)) {
        warnings.push({ kind: 'DID_NOT_APPLY', slotId: slot.id, staffId, message: `${name(staffId)} did not apply for this shift.` })
      }
    }
  }

  const shares = fairShares(input as EngineInput, emptyState())
  const fairness: StaffFairness[] = input.staff.map((staff) => {
    const applied = input.slots.filter((slot) => input.applications.get(slot.id)?.has(staff.id))
    const assignedShifts = state.shifts.get(staff.id) ?? 0
    const assignedMinutes = state.minutes.get(staff.id) ?? 0
    if (assignedShifts > input.limits.maxShifts) {
      warnings.push({ kind: 'OVER_MAX_SHIFTS', slotId: null, staffId: staff.id, message: `${staff.name} has ${assignedShifts} shifts, above the most of ${input.limits.maxShifts}.` })
    } else if (assignedShifts > input.limits.targetShifts) {
      warnings.push({ kind: 'OVER_TARGET', slotId: null, staffId: staff.id, message: `${staff.name} has ${assignedShifts} shifts, above the usual ${input.limits.targetShifts}.` })
    }
    if (assignedMinutes > input.limits.maxMinutes) {
      warnings.push({ kind: 'OVER_MAX_HOURS', slotId: null, staffId: staff.id, message: `${staff.name} has ${hours(assignedMinutes)}, above the most of ${hours(input.limits.maxMinutes)}.` })
    }
    return {
      staffId: staff.id,
      appliedShifts: applied.length,
      appliedMinutes: applied.reduce((sum, slot) => sum + minutesOf(slot), 0),
      assignedShifts,
      assignedMinutes,
      fairShareMinutes: Math.round(shares.get(staff.id) ?? 0),
      fillRate: applied.length === 0 ? null : assignedShifts / applied.length,
    }
  })

  return { warnings, fairness }
}

/** The warnings one new placement would add — shown when management assigns by hand. */
export function warningsForPlacement(
  input: Omit<EngineInput, 'locked'>,
  current: Placement[],
  placement: Placement,
): Warning[] {
  const before = evaluateRoster(input, current).warnings
  const seen = new Set(before.map(warningKey))
  return evaluateRoster(input, [...current, placement]).warnings.filter(
    (warning) => !seen.has(warningKey(warning)) && warning.kind !== 'UNFILLED',
  )
}

export type ReplacementCandidate = {
  staffId: string
  appliedForSlot: boolean
  /** Management only: why they are where they are in the queue. */
  reason: string
}

/**
 * Who to offer a vacated seat to, in order. People who applied for the shift
 * and were not picked come first; then anyone else free. Within each, the same
 * suitability and fairness as the engine. People with a clash, over their
 * limits, or listed in `exclude` (already offered, the one who withdrew) are
 * left out.
 */
export function rankReplacements(
  input: Omit<EngineInput, 'locked'>,
  current: Placement[],
  slotId: string,
  exclude: Set<string>,
): ReplacementCandidate[] {
  const slot = input.slots.find((candidate) => candidate.id === slotId)
  if (!slot) return []
  const state = emptyState()
  const slotById = new Map(input.slots.map((candidate) => [candidate.id, candidate]))
  for (const placement of current) {
    const placed = slotById.get(placement.slotId)
    if (placed) place(state, placed, placement.staffId)
  }
  // A vacancy is an open seat even if the slot shows as full elsewhere.
  const seatSlot = { ...slot, requiredStaff: (state.bySlot.get(slot.id)?.length ?? 0) + 1 }
  const engineInput = { ...input, locked: [] } as EngineInput

  return input.staff
    .filter((staff) => !exclude.has(staff.id) && feasible(state, engineInput, seatSlot, staff))
    .map((staff) => {
      const applied = Boolean(input.applications.get(slot.id)?.has(staff.id))
      const fit = suitability(state, engineInput, seatSlot, staff)
      const minutes = state.minutes.get(staff.id) ?? 0
      return {
        staff,
        applied,
        total: fit.score - (input.weights.fairness * minutes) / 600,
        minutes,
        reason: [
          applied ? 'Applied for this shift' : 'Did not apply, but is free',
          `${hours(minutes)} this week`,
          ...fit.reasons,
        ].join(' · '),
      }
    })
    .toSorted(
      (a, b) =>
        Number(b.applied) - Number(a.applied) ||
        b.total - a.total ||
        a.minutes - b.minutes ||
        stableHash(`${slotId}:${a.staff.id}`) - stableHash(`${slotId}:${b.staff.id}`),
    )
    .map((entry) => ({ staffId: entry.staff.id, appliedForSlot: entry.applied, reason: entry.reason }))
}
