import { Prisma } from '@prisma/client'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { permissionsFor, requirePermission } from '../auth.ts'
import type { Tx } from '../db.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { actorOf, audit } from '../team/audit.ts'
import { generatePin, revokeStaffSessions, setStaffPin } from '../team/pins.ts'
import { unsealPin } from '../team/seal.ts'

/**
 * Team, management side: staff, their confidential attributes, PINs, work
 * types and the business's team settings. Every route needs an RMS session
 * and the named permission; the business is always the session's own.
 */

const ID = z.string().uuid()
const PIN = z.string().regex(/^\d{4}$/)
const ROLE_TAGS = z.array(z.string().trim().toLowerCase().min(1).max(30)).max(20)

const staffCreate = z.object({
  name: z.string().trim().min(1).max(80),
  /** Left blank, the next free S-number is used. */
  staffCode: z.string().trim().toUpperCase().min(1).max(20).nullish(),
  defaultWorkTypeId: ID.nullish(),
  roleTags: ROLE_TAGS.default([]),
})

const staffUpdate = z
  .object({
    name: z.string().trim().min(1).max(80),
    staffCode: z.string().trim().toUpperCase().min(1).max(20),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    defaultWorkTypeId: ID.nullable(),
    roleTags: ROLE_TAGS,
  })
  .partial()

const SCORE = z.number().int().min(1).max(5).nullable()
const attributesBody = z
  .object({
    reliability: SCORE,
    capability: SCORE,
    experience: SCORE,
    soloSuitability: z.enum(['SUITABLE', 'CAUTION', 'NOT_RECOMMENDED']),
    trainingStatus: z.enum(['TRAINEE', 'TRAINED']),
    managementPriority: z.number().int().min(-2).max(2),
    notes: z.string().trim().max(2000).nullable(),
    extra: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])),
  })
  .partial()

const pinBody = z.object({
  /** Omitted: a random one is generated. */
  pin: PIN.nullish(),
})

const workTypeCreate = z.object({
  name: z.string().trim().min(1).max(40),
  rateSenPerHour: z.number().int().min(0).max(1_000_000),
  description: z.string().trim().max(200).nullish(),
})

const workTypeUpdate = workTypeCreate.extend({ isActive: z.boolean() }).partial()

const settingsBody = z
  .object({
    applicationLimit: z.number().int().min(0).max(100),
    assignmentTargetShifts: z.number().int().min(0).max(50),
    assignmentMaxShifts: z.number().int().min(0).max(50),
    assignmentMaxMinutes: z.number().int().min(0).max(10_080),
    withdrawalDeadlineHours: z.number().int().min(0).max(24 * 14),
    urgentCoverageHours: z.number().int().min(0).max(24 * 14),
    payRoundingMinutes: z.number().int().min(1).max(60),
    payRoundingMode: z.enum(['FLOOR', 'NEAREST']),
    payFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM']),
    payAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    paydayOffsetDays: z.number().int().min(0).max(60),
    engineWeights: z.record(z.string(), z.number().min(-100).max(100)),
    /** Letters and digits only; stored upper-case. Null removes it. */
    orgCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4,16}$/)
      .nullable(),
  })
  .partial()

type StaffRow = Prisma.StaffMemberGetPayload<{
  include: { attributes: true; credentials: { select: { kind: true; setAt: true } } }
}>

/**
 * A staff member as management sees them. The confidential attributes are
 * included only for a session allowed to read them — for anyone else the key
 * is absent from the response, not merely blank.
 */
function serialiseStaff(staff: StaffRow, withConfidential: boolean) {
  const pin = staff.credentials.find((credential) => credential.kind === 'PIN')
  return {
    id: staff.id,
    name: staff.name,
    staffCode: staff.staffCode,
    status: staff.status,
    defaultWorkTypeId: staff.defaultWorkTypeId,
    roleTags: staff.roleTags,
    hasPin: Boolean(pin),
    pinSetAt: pin?.setAt.toISOString() ?? null,
    createdAt: staff.createdAt.toISOString(),
    ...(withConfidential
      ? {
          attributes: staff.attributes
            ? {
                reliability: staff.attributes.reliability,
                capability: staff.attributes.capability,
                experience: staff.attributes.experience,
                soloSuitability: staff.attributes.soloSuitability,
                trainingStatus: staff.attributes.trainingStatus,
                managementPriority: staff.attributes.managementPriority,
                notes: staff.attributes.notes,
                extra: staff.attributes.extra,
              }
            : null,
        }
      : {}),
  }
}

const STAFF_INCLUDE = {
  attributes: true,
  credentials: { select: { kind: true, setAt: true } },
} as const

function canSeeConfidential(request: FastifyRequest): boolean {
  return permissionsFor(request.user.scope).has('staff.confidential')
}

/** The next S-number not yet taken: S001, S002, … */
async function nextStaffCode(tx: Tx): Promise<string> {
  const codes = await tx.staffMember.findMany({ select: { staffCode: true } })
  const taken = new Set(codes.map((row) => row.staffCode))
  for (let n = codes.length + 1; ; n += 1) {
    const code = `S${n.toString().padStart(3, '0')}`
    if (!taken.has(code)) return code
  }
}

async function assertWorkType(tx: Tx, id: string | null | undefined): Promise<void> {
  if (!id) return
  const workType = await tx.workType.findUnique({ where: { id } })
  if (!workType) throw badRequest('team:WORK_TYPE_NOT_FOUND')
}

/** A unique-constraint clash on a name or code, as a plain 409. */
function translateTaken(code: string) {
  return (error: unknown): never => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict(code)
    }
    throw error
  }
}

function serialiseSettings(settings: Prisma.TeamSettingsGetPayload<object>) {
  return {
    applicationLimit: settings.applicationLimit,
    assignmentTargetShifts: settings.assignmentTargetShifts,
    assignmentMaxShifts: settings.assignmentMaxShifts,
    assignmentMaxMinutes: settings.assignmentMaxMinutes,
    withdrawalDeadlineHours: settings.withdrawalDeadlineHours,
    urgentCoverageHours: settings.urgentCoverageHours,
    payRoundingMinutes: settings.payRoundingMinutes,
    payRoundingMode: settings.payRoundingMode,
    payFrequency: settings.payFrequency,
    payAnchorDate: settings.payAnchorDate.toISOString().slice(0, 10),
    paydayOffsetDays: settings.paydayOffsetDays,
    engineWeights: settings.engineWeights,
    orgCode: settings.orgCode,
  }
}

/** The business's team settings, created with the defaults on first use. */
export async function teamSettingsFor(tx: Tx, businessId: string) {
  return tx.teamSettings.upsert({
    where: { businessId },
    update: {},
    create: { businessId },
  })
}

export async function teamRmsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------

  app.get('/rms/team/staff', { preHandler: requirePermission('staff.manage') }, async (request) => {
    const staff = await request.db.staffMember.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: STAFF_INCLUDE,
    })
    const withConfidential = canSeeConfidential(request)
    return { staff: staff.map((row) => serialiseStaff(row, withConfidential)) }
  })

  /**
   * Add a staff member. They get a random PIN, returned here once and never
   * again — the database keeps only its hash.
   */
  app.post('/rms/team/staff', { preHandler: requirePermission('staff.manage') }, async (request) => {
    const body = staffCreate.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const pin = generatePin()

    const created = await db
      .$transaction(async (tx) => {
        await assertWorkType(tx, body.defaultWorkTypeId)
        const staff = await tx.staffMember.create({
          data: {
            businessId,
            name: body.name,
            staffCode: body.staffCode ?? (await nextStaffCode(tx)),
            defaultWorkTypeId: body.defaultWorkTypeId ?? null,
            roleTags: body.roleTags,
          },
        })
        await setStaffPin(tx, businessId, staff.id, pin)
        await audit(tx, businessId, actor, {
          action: 'staff.created',
          entityType: 'staff',
          entityId: staff.id,
          after: { name: staff.name, staffCode: staff.staffCode },
        })
        return tx.staffMember.findUniqueOrThrow({ where: { id: staff.id }, include: STAFF_INCLUDE })
      })
      .catch(translateTaken('team:STAFF_CODE_TAKEN'))

    return { staff: serialiseStaff(created, canSeeConfidential(request)), pin }
  })

  app.patch<{ Params: { id: string } }>(
    '/rms/team/staff/:id',
    { preHandler: requirePermission('staff.manage') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const body = staffUpdate.parse(request.body)
      const { db, businessId } = request
      const actor = await actorOf(request)

      const updated = await db
        .$transaction(async (tx) => {
          const before = await tx.staffMember.findUnique({ where: { id } })
          if (!before) throw notFound('team:STAFF_NOT_FOUND')
          await assertWorkType(tx, body.defaultWorkTypeId)

          const after = await tx.staffMember.update({ where: { id }, data: body })
          // Deactivated: their phone is signed out on its next request.
          if (body.status === 'INACTIVE' && before.status !== 'INACTIVE') {
            await revokeStaffSessions(tx, id)
          }
          await audit(tx, businessId, actor, {
            action: body.status && body.status !== before.status ? `staff.${body.status.toLowerCase()}` : 'staff.updated',
            entityType: 'staff',
            entityId: id,
            before: {
              name: before.name,
              staffCode: before.staffCode,
              status: before.status,
              defaultWorkTypeId: before.defaultWorkTypeId,
              roleTags: before.roleTags,
            },
            after: {
              name: after.name,
              staffCode: after.staffCode,
              status: after.status,
              defaultWorkTypeId: after.defaultWorkTypeId,
              roleTags: after.roleTags,
            },
          })
          return tx.staffMember.findUniqueOrThrow({ where: { id }, include: STAFF_INCLUDE })
        })
        .catch(translateTaken('team:STAFF_CODE_TAKEN'))

      return { staff: serialiseStaff(updated, canSeeConfidential(request)) }
    },
  )

  /**
   * Delete a staff member for good — for someone added by mistake, or who
   * never worked. Anyone with hours or pay on record is refused: deleting them
   * would tear the history out of payroll and the books. Deactivate them
   * instead. Their shifts, applications and offers go with them, and any
   * phone they are signed in on is signed out.
   */
  app.delete<{ Params: { id: string } }>(
    '/rms/team/staff/:id',
    { preHandler: requirePermission('staff.manage') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const { db, businessId } = request
      const actor = await actorOf(request)
      await db.$transaction(async (tx) => {
        const staff = await tx.staffMember.findUnique({ where: { id } })
        if (!staff) throw notFound('team:STAFF_NOT_FOUND')
        const [attendance, payslips, adjustments] = await Promise.all([
          tx.attendanceRecord.count({ where: { staffId: id } }),
          tx.payslip.count({ where: { staffId: id } }),
          tx.payrollAdjustment.count({ where: { staffId: id } }),
        ])
        if (attendance + payslips + adjustments > 0) throw conflict('team:STAFF_HAS_HISTORY')

        const assignments = await tx.assignment.findMany({ where: { staffId: id }, select: { id: true, slot: { select: { rosterWeekId: true } } } })
        await tx.coverageRequest.updateMany({
          where: { vacatedAssignmentId: { in: assignments.map((assignment) => assignment.id) } },
          data: { vacatedAssignmentId: null },
        })
        await tx.assignment.deleteMany({ where: { staffId: id } })
        await tx.replacementOffer.deleteMany({ where: { staffId: id } })
        await tx.shiftApplication.deleteMany({ where: { staffId: id } })
        await tx.session.deleteMany({ where: { staffId: id } })
        await tx.staffMember.delete({ where: { id } })
        for (const weekId of new Set(assignments.map((assignment) => assignment.slot.rosterWeekId))) {
          await tx.rosterWeek.update({ where: { id: weekId }, data: { version: { increment: 1 } } })
        }
        await audit(tx, businessId, actor, {
          action: 'staff.deleted',
          entityType: 'staff',
          entityId: id,
          before: { name: staff.name, staffCode: staff.staffCode, shiftsRemoved: assignments.length },
        })
      })
      return { ok: true }
    },
  )

  /** Confidential: management's read of a staff member. Never reaches /team. */
  app.put<{ Params: { id: string } }>(
    '/rms/team/staff/:id/attributes',
    { preHandler: requirePermission('staff.confidential') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const body = attributesBody.parse(request.body)
      const { db, businessId } = request
      const actor = await actorOf(request)

      const staff = await db.$transaction(async (tx) => {
        if (!(await tx.staffMember.findUnique({ where: { id } }))) {
          throw notFound('team:STAFF_NOT_FOUND')
        }
        const before = await tx.staffAttributes.findUnique({ where: { staffId: id } })
        const data = {
          ...body,
          ...(body.extra ? { extra: body.extra as Prisma.InputJsonValue } : {}),
        }
        const after = await tx.staffAttributes.upsert({
          where: { staffId: id },
          update: data,
          create: { businessId, staffId: id, ...data },
        })
        await audit(tx, businessId, actor, {
          action: 'staff.attributes_changed',
          entityType: 'staff',
          entityId: id,
          before,
          after,
        })
        return tx.staffMember.findUniqueOrThrow({ where: { id }, include: STAFF_INCLUDE })
      })

      return { staff: serialiseStaff(staff, true) }
    },
  )

  /**
   * A new PIN: random, or the one management typed. Shown once in this
   * response. The staff member is signed out everywhere.
   */
  app.post<{ Params: { id: string } }>(
    '/rms/team/staff/:id/pin',
    { preHandler: requirePermission('staff.manage') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const body = pinBody.parse(request.body ?? {})
      const { db, businessId } = request
      const actor = await actorOf(request)
      const pin = body.pin ?? generatePin()

      await db.$transaction(async (tx) => {
        if (!(await tx.staffMember.findUnique({ where: { id } }))) {
          throw notFound('team:STAFF_NOT_FOUND')
        }
        await setStaffPin(tx, businessId, id, pin)
        await audit(tx, businessId, actor, {
          action: body.pin ? 'staff.pin_set' : 'staff.pin_reset',
          entityType: 'staff',
          entityId: id,
        })
      })
      return { pin }
    },
  )

  /**
   * Look up a staff member's current PIN — the RMS's eye button. Each look is
   * recorded in the audit trail. A PIN set before PINs were kept this way, or
   * under an old server key, cannot be shown: reset it to get a viewable one.
   */
  app.get<{ Params: { id: string } }>(
    '/rms/team/staff/:id/pin',
    { preHandler: requirePermission('staff.manage') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const { db, businessId } = request
      const actor = await actorOf(request)
      return db.$transaction(async (tx) => {
        if (!(await tx.staffMember.findUnique({ where: { id } }))) throw notFound('team:STAFF_NOT_FOUND')
        const credential = await tx.staffCredential.findFirst({ where: { staffId: id, kind: 'PIN' } })
        const pin = unsealPin(credential?.secretSealed ?? null)
        if (pin) await audit(tx, businessId, actor, { action: 'staff.pin_viewed', entityType: 'staff', entityId: id })
        return { pin, viewable: pin !== null }
      })
    },
  )

  // -------------------------------------------------------------------------
  // Work types
  // -------------------------------------------------------------------------

  app.get('/rms/team/work-types', { preHandler: requirePermission('staff.manage') }, async (request) => {
    const workTypes = await request.db.workType.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    })
    return { workTypes: workTypes.map(serialiseWorkType) }
  })

  app.post('/rms/team/work-types', { preHandler: requirePermission('payroll.process') }, async (request) => {
    const body = workTypeCreate.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)
    const workType = await db
      .$transaction(async (tx) => {
        const created = await tx.workType.create({
          data: { businessId, ...body, description: body.description ?? null },
        })
        await audit(tx, businessId, actor, {
          action: 'work_type.created',
          entityType: 'work_type',
          entityId: created.id,
          after: created,
        })
        return created
      })
      .catch(translateTaken('team:WORK_TYPE_NAME_TAKEN'))
    return { workType: serialiseWorkType(workType) }
  })

  /**
   * Change a work type. A new rate applies to pay not yet approved; approved
   * and paid payslips keep the rate they were priced at.
   */
  app.patch<{ Params: { id: string } }>(
    '/rms/team/work-types/:id',
    { preHandler: requirePermission('payroll.process') },
    async (request) => {
      const id = ID.parse(request.params.id)
      const body = workTypeUpdate.parse(request.body)
      const { db, businessId } = request
      const actor = await actorOf(request)
      const workType = await db
        .$transaction(async (tx) => {
          const before = await tx.workType.findUnique({ where: { id } })
          if (!before) throw notFound('team:WORK_TYPE_NOT_FOUND')
          const after = await tx.workType.update({ where: { id }, data: body })
          await audit(tx, businessId, actor, {
            action: 'work_type.changed',
            entityType: 'work_type',
            entityId: id,
            before,
            after,
          })
          return after
        })
        .catch(translateTaken('team:WORK_TYPE_NAME_TAKEN'))
      return { workType: serialiseWorkType(workType) }
    },
  )

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  app.get('/rms/team/settings', { preHandler: requirePermission('roster.manage') }, async (request) => {
    const settings = await teamSettingsFor(request.db, request.businessId)
    return { settings: serialiseSettings(settings) }
  })

  app.put('/rms/team/settings', { preHandler: requirePermission('roster.manage') }, async (request) => {
    const body = settingsBody.parse(request.body)
    const { db, businessId } = request
    const actor = await actorOf(request)

    const settings = await db
      .$transaction(async (tx) => {
        const before = await teamSettingsFor(tx, businessId)
        const target = body.assignmentTargetShifts ?? before.assignmentTargetShifts
        const max = body.assignmentMaxShifts ?? before.assignmentMaxShifts
        if (max < target) throw badRequest('team:TARGET_ABOVE_MAX')

        const { payAnchorDate, engineWeights, ...rest } = body
        const after = await tx.teamSettings.update({
          where: { businessId },
          data: {
            ...rest,
            ...(payAnchorDate ? { payAnchorDate: new Date(`${payAnchorDate}T00:00:00Z`) } : {}),
            ...(engineWeights ? { engineWeights: engineWeights as Prisma.InputJsonValue } : {}),
          },
        })
        await audit(tx, businessId, actor, {
          action: 'team_settings.changed',
          entityType: 'team_settings',
          entityId: businessId,
          before: serialiseSettings(before),
          after: serialiseSettings(after),
        })
        return after
      })
      .catch(translateTaken('team:ORG_CODE_TAKEN'))

    return { settings: serialiseSettings(settings) }
  })

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  const auditQuery = z.object({
    entityType: z.string().max(40).optional(),
    entityId: z.string().max(64).optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })

  app.get('/rms/team/audit', { preHandler: requirePermission('audit.view') }, async (request) => {
    const query = auditQuery.parse(request.query)
    const rows = await request.db.teamAuditEntry.findMany({
      where: {
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.before ? { id: { lt: BigInt(query.before) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
    })
    return {
      entries: rows.map((row) => ({
        id: Number(row.id),
        actorKind: row.actorKind,
        actorLabel: row.actorLabel,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        before: row.before,
        after: row.after,
        createdAt: row.createdAt.toISOString(),
      })),
    }
  })
}

function serialiseWorkType(workType: Prisma.WorkTypeGetPayload<object>) {
  return {
    id: workType.id,
    name: workType.name,
    rateSenPerHour: workType.rateSenPerHour,
    description: workType.description,
    isActive: workType.isActive,
  }
}
