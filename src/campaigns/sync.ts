import { Prisma, type PrismaClient } from '@prisma/client'
import { badRequest, conflict } from '../errors.ts'
import { campaignAudit, type CampaignActor } from './audit.ts'
import { driveFileId, readSheetTab, type GoogleCredentials } from './google.ts'
import { openSecret } from './secrets.ts'
import { parseSheet, type ImportedOrder, type SheetConfig } from './sheet-import.ts'
import { pushToSheet } from './writeback.ts'

/**
 * Bring a campaign's orders in from its source. Safe to run any number of
 * times: an order is found again by its source reference and a coupon by its
 * code, so nothing is duplicated. It never touches the owner's decision on a
 * payment (verified / rejected, payment date, ledger lines) and never writes
 * to the source.
 */

const STALE_RUN_MS = 5 * 60_000

type Product = { id: string; externalKey: string | null; priceSen: number }

/** The campaign product a line names: exact, or the name followed by more detail ("Crimson Charm (Rose set)"). */
export function matchProduct(label: string, products: Product[]): Product | null {
  const text = label.trim().toLowerCase()
  let best: Product | null = null
  for (const product of products) {
    const key = product.externalKey?.trim().toLowerCase()
    if (!key) continue
    if (text === key) return product
    if (text.startsWith(key) && /[\s(\-–:,]/.test(text.charAt(key.length)) && (!best || key.length > best.externalKey!.length)) best = product
  }
  return best
}

export type SyncSummary = { runId: string; added: number; updated: number; unchanged: number; skipped: number; notes: string[] }

function sheetConfig(raw: Prisma.JsonValue): { sheetId: string; tab: string; config: SheetConfig } {
  const value = (raw ?? {}) as Record<string, unknown>
  const columns = value.columns as SheetConfig['columns'] | undefined
  if (typeof value.sheetId !== 'string' || typeof value.tab !== 'string' || !columns?.orderRef || !columns.customerName) {
    throw badRequest('campaign:SOURCE_NOT_SET', 'sheetId, tab and the order/name columns are required')
  }
  return {
    sheetId: value.sheetId,
    tab: value.tab,
    config: {
      columns,
      totalPer: value.totalPer === 'LINE' ? 'LINE' : 'ORDER',
      fulfilmentColumns: Array.isArray(value.fulfilmentColumns) ? (value.fulfilmentColumns as string[]) : [],
    },
  }
}

/**
 * The Google login a campaign uses: Vista's own connection when its source
 * says `auth: 'VISTA'` (share the sheet with that account), else its sealed keys.
 */
export function sourceCredentials(campaign: { sourceConfig: Prisma.JsonValue; sourceSecret: string | null }): GoogleCredentials {
  const auth = ((campaign.sourceConfig ?? {}) as Record<string, unknown>).auth
  if (auth === 'VISTA') {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) throw badRequest('campaign:SOURCE_NOT_SET', "Vista's Google connection is not set up")
    return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN }
  }
  const sealed = campaign.sourceSecret
  if (!sealed) throw badRequest('campaign:SOURCE_NOT_SET', 'no credentials saved')
  const secret = openSecret(sealed)
  if (!secret.clientId || !secret.clientSecret || !secret.refreshToken) throw badRequest('campaign:SOURCE_NOT_SET', 'credentials incomplete')
  return { clientId: secret.clientId, clientSecret: secret.clientSecret, refreshToken: secret.refreshToken }
}

/** JSON compared by content: Postgres stores objects with their keys reordered. */
function json(value: unknown): string {
  const sort = (inner: unknown): unknown =>
    Array.isArray(inner)
      ? inner.map(sort)
      : inner && typeof inner === 'object'
        ? Object.fromEntries(Object.keys(inner as object).toSorted().map((key) => [key, sort((inner as Record<string, unknown>)[key])]))
        : inner
  return JSON.stringify(sort(value ?? null))
}

export async function syncCampaign(
  db: PrismaClient,
  businessId: string,
  campaignId: string,
  trigger: 'MANUAL' | 'SCHEDULED',
  actor: CampaignActor,
  read: typeof readSheetTab = readSheetTab,
): Promise<SyncSummary> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign) throw badRequest('campaign:NOT_FOUND')
  if (campaign.sourceKind !== 'GOOGLE_SHEET') throw badRequest('campaign:SOURCE_NOT_SET')
  const { sheetId, tab, config } = sheetConfig(campaign.sourceConfig)
  const credentials = sourceCredentials(campaign)

  // One sync at a time per campaign; a run stuck for 5 minutes is abandoned.
  const run = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':campaign-sync:' + campaignId}))`
    const running = await tx.campaignSyncRun.findFirst({
      where: { campaignId, status: 'RUNNING', startedAt: { gt: new Date(Date.now() - STALE_RUN_MS) } },
    })
    if (running) throw conflict('campaign:SYNC_RUNNING')
    await tx.campaignSyncRun.updateMany({ where: { campaignId, status: 'RUNNING' }, data: { status: 'FAILED', error: 'abandoned', finishedAt: new Date() } })
    return tx.campaignSyncRun.create({ data: { businessId, campaignId, trigger } })
  })

  const summary: SyncSummary = { runId: run.id, added: 0, updated: 0, unchanged: 0, skipped: 0, notes: [] }
  try {
    // Vista's own changes go to the sheet first, so the read below already shows them.
    const pushed = await pushToSheet(db, campaignId, { read })
    if (pushed.error) summary.notes.push(`writing to the sheet failed: ${pushed.error}`)
    const parsed = parseSheet(await read(credentials, sheetId, tab), config)
    summary.skipped += parsed.skipped.length
    summary.notes.push(...parsed.skipped.slice(0, 20).map((skip) => `row ${skip.row}: ${skip.reason}`))

    const products = await db.campaignProduct.findMany({ where: { campaignId }, select: { id: true, externalKey: true, priceSen: true } })
    const existing = new Map(
      (
        await db.campaignOrder.findMany({
          where: { campaignId },
          include: { lines: true, coupons: { select: { code: true } }, proof: true },
        })
      ).map((order) => [order.externalRef, order]),
    )

    for (const incoming of parsed.orders) {
      try {
        const outcome = await upsertOrder(db, businessId, campaignId, incoming, products, existing.get(incoming.externalRef) ?? null, summary)
        summary[outcome] += 1
      } catch (caught) {
        summary.skipped += 1
        summary.notes.push(`${incoming.externalRef}: ${caught instanceof Error ? caught.message.slice(0, 160) : 'could not be saved'}`)
      }
    }
    const seen = parsed.orders.map((order) => order.externalRef)
    if (seen.length) await db.campaignOrder.updateMany({ where: { campaignId, externalRef: { in: seen } }, data: { lastSeenAt: new Date() } })

    await db.$transaction(async (tx) => {
      await tx.campaignSyncRun.update({
        where: { id: run.id },
        data: {
          status: 'OK',
          added: summary.added,
          updated: summary.updated,
          unchanged: summary.unchanged,
          skipped: summary.skipped,
          error: summary.notes.length ? summary.notes.join('\n').slice(0, 2000) : null,
          finishedAt: new Date(),
        },
      })
      await tx.campaign.update({ where: { id: campaignId }, data: { lastSyncedAt: new Date() } })
      if (summary.added || summary.updated || trigger === 'MANUAL') {
        await campaignAudit(tx, businessId, actor, {
          campaignId,
          action: 'campaign.sync',
          after: { trigger, added: summary.added, updated: summary.updated, unchanged: summary.unchanged, skipped: summary.skipped },
        })
      }
    })
    return summary
  } catch (caught) {
    const message = caught instanceof Error ? caught.message.slice(0, 500) : 'sync failed'
    await db.campaignSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } })
    throw badRequest('campaign:SYNC_FAILED', message)
  }
}

type Existing = Prisma.CampaignOrderGetPayload<{ include: { lines: true; coupons: { select: { code: true } }; proof: true } }>

async function upsertOrder(
  db: PrismaClient,
  businessId: string,
  campaignId: string,
  incoming: ImportedOrder,
  products: Product[],
  existing: Existing | null,
  summary: SyncSummary,
): Promise<'added' | 'updated' | 'unchanged'> {
  const lines = incoming.lines.map((line) => {
    const product = matchProduct(line.label, products)
    return { ...line, product, priceSen: line.priceSen ?? product?.priceSen ?? 0 }
  })
  const expectedSen = incoming.totalSen ?? lines.reduce((sum, line) => sum + line.priceSen, 0)
  const proofRef = driveFileId(incoming.proofUrl)
  const submittedAt = incoming.submittedAt ?? existing?.submittedAt ?? new Date()
  const sourceData = { rows: incoming.sourceData } as Prisma.InputJsonValue

  return db.$transaction(async (tx) => {
    // Codes already taken by another order are reported, never moved.
    const codes = lines.flatMap((line) => (line.coupon ? [line.coupon] : []))
    const taken = new Set(
      (await tx.campaignCoupon.findMany({ where: { code: { in: codes } }, select: { code: true, orderId: true } }))
        .filter((coupon) => coupon.orderId !== existing?.id)
        .map((coupon) => coupon.code),
    )
    for (const code of taken) summary.notes.push(`${incoming.externalRef}: coupon ${code} already belongs to another order`)

    if (!existing) {
      const order = await tx.campaignOrder.create({
        data: {
          businessId,
          campaignId,
          externalRef: incoming.externalRef,
          customerName: incoming.customerName,
          contact: incoming.contact,
          submittedAt,
          expectedSen,
          fulfilment: incoming.fulfilment,
          sourceData,
          sourceStatus: incoming.sourceStatus,
        },
      })
      for (const line of lines) {
        const created = await tx.campaignOrderLine.create({
          data: {
            businessId,
            orderId: order.id,
            campaignProductId: line.product?.id ?? null,
            lineNo: line.lineNo,
            label: line.label,
            priceSen: line.priceSen,
            details: line.details,
          },
        })
        if (line.coupon && !taken.has(line.coupon)) {
          await tx.campaignCoupon.create({ data: { businessId, campaignId, orderId: order.id, orderLineId: created.id, code: line.coupon } })
        }
      }
      await tx.campaignPaymentProof.create({
        data: {
          businessId,
          orderId: order.id,
          sourceRef: proofRef,
          sourceUrl: incoming.proofUrl,
          readStatus: proofRef ? 'PENDING' : 'NONE',
        },
      })
      return 'added'
    }

    let changed = false
    const undecided = existing.verification === 'UNVERIFIED'
    const update: Prisma.CampaignOrderUpdateInput = {}
    if (existing.customerName !== incoming.customerName) update.customerName = incoming.customerName
    if (existing.contact !== incoming.contact) update.contact = incoming.contact
    if (existing.sourceStatus !== incoming.sourceStatus) update.sourceStatus = incoming.sourceStatus
    if (json(existing.fulfilment) !== json(incoming.fulfilment)) update.fulfilment = incoming.fulfilment
    if (json(existing.sourceData) !== json(sourceData)) update.sourceData = sourceData
    // What was owed only changes while nobody has decided on the payment.
    if (undecided && existing.expectedSen !== expectedSen) update.expectedSen = expectedSen
    if (Object.keys(update).length) {
      await tx.campaignOrder.update({ where: { id: existing.id }, data: update })
      changed = true
    }

    for (const line of lines) {
      const current = existing.lines.find((row) => row.lineNo === line.lineNo)
      let lineId = current?.id
      if (!current) {
        lineId = (
          await tx.campaignOrderLine.create({
            data: {
              businessId,
              orderId: existing.id,
              campaignProductId: line.product?.id ?? null,
              lineNo: line.lineNo,
              label: line.label,
              priceSen: line.priceSen,
              details: line.details,
            },
          })
        ).id
        changed = true
      } else if (current.label !== line.label || json(current.details) !== json(line.details) || (undecided && current.priceSen !== line.priceSen)) {
        await tx.campaignOrderLine.update({
          where: { id: current.id },
          data: {
            label: line.label,
            details: line.details,
            campaignProductId: line.product?.id ?? current.campaignProductId,
            ...(undecided ? { priceSen: line.priceSen } : {}),
          },
        })
        changed = true
      }
      if (line.coupon && !taken.has(line.coupon) && !existing.coupons.some((coupon) => coupon.code === line.coupon)) {
        await tx.campaignCoupon.create({ data: { businessId, campaignId, orderId: existing.id, orderLineId: lineId!, code: line.coupon } })
        changed = true
      }
    }

    // A new proof file is read again, unless the owner already decided.
    if (existing.proof && existing.proof.sourceRef !== proofRef && undecided) {
      await tx.campaignPaymentProof.update({
        where: { id: existing.proof.id },
        data: {
          sourceRef: proofRef,
          sourceUrl: incoming.proofUrl,
          readStatus: proofRef ? 'PENDING' : 'NONE',
          sha256: null,
          extraction: Prisma.DbNull,
          flags: [],
          summary: null,
          attempts: 0,
          readAt: null,
          dismissedAt: null,
        },
      })
      changed = true
    }
    return changed ? 'updated' : 'unchanged'
  })
}
