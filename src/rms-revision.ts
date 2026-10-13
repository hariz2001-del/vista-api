import { Prisma } from '@prisma/client'
import type { Tx } from './db.ts'

// Compute the fingerprint INSIDE Postgres: no history crosses the pooler on
// unchanged polls. Includes updates/deletes, not just newest dates or row counts.
// This is a bounded operational stopgap; large businesses should use a durable
// write-revision and paginated read models rather than hashing growing history.
const TABLES = [
  'account_settings', 'brands', 'categories', 'products', 'modifier_groups',
  'modifier_items', 'partners', 'shifts', 'orders', 'order_items',
  'order_item_modifiers', 'sale_corrections', 'correction_brand_deltas',
  'ledger_entries', 'expenses', 'expense_items', 'period_closures',
  'promotions', 'promotion_targets',
] as const

export async function rmsRevision(db: Tx, businessId: string): Promise<string> {
  const parts = TABLES.map(table => Prisma.sql`
    SELECT ${table} AS name,
      md5(COALESCE(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)), '')) AS digest
    FROM ${Prisma.raw(`"${table}"`)} t WHERE t.business_id = ${businessId}
  `)
  // Only image URL metadata is relevant to the snapshot, never cached image bytes.
  parts.push(Prisma.sql`
    SELECT 'receipt_documents' AS name,
      md5(COALESCE(string_agg(md5(json_build_array(t.id, t.drive_url, t.scan_drive_url)::text), '' ORDER BY t.id), '')) AS digest
    FROM receipt_documents t WHERE t.business_id = ${businessId}
  `)
  const rows = await db.$queryRaw<Array<{ revision: string }>>(Prisma.sql`
    SELECT md5(string_agg(name || digest, '' ORDER BY name)) AS revision
    FROM (${Prisma.join(parts, ' UNION ALL ')}) fingerprints
  `)
  return rows[0]!.revision
}
