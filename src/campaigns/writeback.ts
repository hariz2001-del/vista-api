import type { PrismaClient } from '@prisma/client'
import { columnLetter, readSheetTab, writeSheetCells } from './google.ts'
import { cellParts } from './sheet-import.ts'
import { sourceCredentials } from './sync.ts'

/**
 * Vista → sheet. When the owner decides on a payment, or a coupon is used at
 * the till, the order is marked `sheetDirty`; this writes what changed into the
 * campaign's sheet, so the sheet (and anything that reads it, like the order
 * form's stock count and coupon-status formula) shows the same thing as Vista.
 *
 * It only ever sets two kinds of cell, both configured per campaign:
 *  - the status cell of each of the order's rows (verified → "Paid", rejected →
 *    "Rejected", undone → back to "Pending check");
 *  - the "voucher redeemed" tick of the row whose coupon was used.
 * A status the owner moved further on in the sheet (e.g. "Ready", "Collected")
 * is left alone. Rows are found by order code each time, so sorting or
 * filtering the sheet is fine.
 */

type WriteBack = { enabled: boolean; verified: string; rejected: string; unverified: string; keepWhenVerified: string[] }

function settings(raw: unknown): { sheetId: string; tab: string; columns: Record<string, string>; writeBack: WriteBack } | null {
  const config = (raw ?? {}) as Record<string, unknown>
  const wb = config.writeBack as Partial<WriteBack> | undefined
  if (!wb?.enabled || typeof config.sheetId !== 'string' || typeof config.tab !== 'string') return null
  return {
    sheetId: config.sheetId,
    tab: config.tab,
    columns: (config.columns ?? {}) as Record<string, string>,
    writeBack: {
      enabled: true,
      verified: wb.verified ?? 'Paid',
      rejected: wb.rejected ?? 'Rejected',
      unverified: wb.unverified ?? 'Pending check',
      keepWhenVerified: wb.keepWhenVerified ?? [],
    },
  }
}

/** What a status cell should become, or null to leave it as it is. */
export function desiredStatus(verification: string, current: string, wb: WriteBack): string | null {
  if (verification === 'VERIFIED') return current === wb.verified || wb.keepWhenVerified.includes(current) ? null : wb.verified
  if (verification === 'REJECTED') return current === wb.rejected ? null : wb.rejected
  // Undone or reopened: only take back what Vista itself wrote.
  if (current === wb.verified || current === wb.rejected || wb.keepWhenVerified.includes(current)) return wb.unverified
  return null
}

/**
 * The sheet already calls this order paid (someone set it there by hand) while
 * Vista has not verified it. Vista never verifies from the sheet — revenue needs
 * the owner's payment date — so this is only ever shown as a warning.
 */
export function sheetSaysPaid(sourceStatus: string | null, verification: string, sourceConfig: unknown): boolean {
  if (verification !== 'UNVERIFIED' || !sourceStatus) return false
  const wb = ((sourceConfig ?? {}) as { writeBack?: Partial<WriteBack> }).writeBack
  if (!wb) return false
  return [wb.verified ?? 'Paid', ...(wb.keepWhenVerified ?? [])].includes(sourceStatus)
}

const truthy = (value: unknown) => value === true || String(value).toUpperCase() === 'TRUE'

export type PushResult = { written: number; orders: number; error?: string }

export async function pushToSheet(
  db: PrismaClient,
  campaignId: string,
  io: { read?: typeof readSheetTab; write?: typeof writeSheetCells } = {},
): Promise<PushResult> {
  const read = io.read ?? readSheetTab
  const write = io.write ?? writeSheetCells
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign) return { written: 0, orders: 0 }
  const dirty = await db.campaignOrder.findMany({
    where: { campaignId, sheetDirty: true },
    include: { coupons: { include: { redemptions: { where: { status: 'COMPLETED' } } } } },
  })
  if (dirty.length === 0) return { written: 0, orders: 0 }
  const config = settings(campaign.sourceConfig)
  if (!config) {
    // Write-back is off for this campaign: nothing to send.
    await db.campaignOrder.updateMany({ where: { campaignId, sheetDirty: true }, data: { sheetDirty: false } })
    return { written: 0, orders: 0 }
  }

  try {
    const credentials = sourceCredentials(campaign)
    const rows = await read(credentials, config.sheetId, config.tab)
    const headers = (rows[0] ?? []).map((cell) => cellParts(cell).text)
    const at = (key: string) => (config.columns[key] ? headers.indexOf(config.columns[key]!) : -1)
    const refCol = at('orderRef')
    const statusCol = at('status')
    const couponCol = at('coupon')
    const redeemedCol = at('redeemed')
    if (refCol < 0) throw new Error(`the sheet has no "${config.columns.orderRef}" column`)

    const cells: Array<{ range: string; value: string | boolean }> = []
    const done: Array<{ id: string; updatedAt: Date; error: string | null }> = []
    for (const order of dirty) {
      const rowNumbers = rows.flatMap((row, index) => (index > 0 && cellParts(row[refCol]).text === order.externalRef ? [index] : []))
      if (rowNumbers.length === 0) {
        done.push({ id: order.id, updatedAt: order.updatedAt, error: 'order not found in the sheet' })
        continue
      }
      for (const index of rowNumbers) {
        const row = rows[index]!
        const sheetRow = index + 1
        if (statusCol >= 0 && !order.deletedAt) {
          const next = desiredStatus(order.verification, cellParts(row[statusCol]).text, config.writeBack)
          if (next !== null) cells.push({ range: `${config.tab}!${columnLetter(statusCol)}${sheetRow}`, value: next })
        }
        if (redeemedCol >= 0 && couponCol >= 0) {
          const code = cellParts(row[couponCol]).text
          const coupon = order.coupons.find((item) => item.code === code)
          if (coupon) {
            const used = coupon.redemptions.length > 0
            if (used !== truthy(row[redeemedCol])) cells.push({ range: `${config.tab}!${columnLetter(redeemedCol)}${sheetRow}`, value: used })
          }
        }
      }
      done.push({ id: order.id, updatedAt: order.updatedAt, error: null })
    }

    await write(credentials, config.sheetId, cells)
    const now = new Date()
    for (const item of done) {
      // Only clear the mark if nothing changed the order since it was read.
      await db.campaignOrder.updateMany({
        where: { id: item.id, updatedAt: item.updatedAt },
        data: { sheetDirty: false, sheetPushedAt: now, sheetPushError: item.error },
      })
    }
    return { written: cells.length, orders: done.length }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message.slice(0, 300) : 'could not write to the sheet'
    await db.campaignOrder.updateMany({ where: { campaignId, sheetDirty: true }, data: { sheetPushError: message } })
    return { written: 0, orders: 0, error: message }
  }
}

/** Write now, but never let the sheet hold up or fail the owner's action. */
export async function pushSoon(db: PrismaClient, campaignId: string): Promise<PushResult | null> {
  try {
    return await Promise.race([
      pushToSheet(db, campaignId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ])
  } catch {
    return null
  }
}
