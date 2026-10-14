import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { PrismaClient } from '@prisma/client'
const sourceEnv = parseEnv(await readFile('.env.source-pre-migration.production', 'utf8'))
const targetEnv = parseEnv(await readFile('.env.migration', 'utf8'))
if (decodeURIComponent(new URL(sourceEnv.DIRECT_URL).username) !== 'postgres.kjjbijhszwpiyicoftls' || decodeURIComponent(new URL(targetEnv.TARGET_DIRECT_URL).username) !== 'postgres.xgahhzjzaibykseqmqhz') throw new Error('Identity guard')
const source = new PrismaClient({ datasources: { db: { url: sourceEnv.DIRECT_URL } }, log: [] })
const target = new PrismaClient({ datasources: { db: { url: targetEnv.TARGET_DIRECT_URL } }, log: [] })
async function inventory(db) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const tables = await tx.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    const result = []
    for (const { tablename } of tables) {
      const name = '"' + tablename.replaceAll('"', '""') + '"'
      const rows = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS hash FROM public.${name} t`)
      result.push({ table: tablename, ...rows[0] })
    }
    const rls = await tx.$queryRawUnsafe("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")
    const constraints = await tx.$queryRawUnsafe("SELECT r.relname,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' ORDER BY r.relname,c.conname")
    const triggers = await tx.$queryRawUnsafe("SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname")
    // These three AND-only checks are reparenthesized by pg_dump/PG17.11.
    // Compare their operator/operand tokens, not redundant AND grouping.
    const andOnly = ['account_settings_pct_range', 'operating_hours_valid', 'slot_templates_valid']
    for (const c of constraints) if (andOnly.includes(c.conname) && !/\bOR\b/.test(c.definition)) c.definition = c.definition.replace(/[()]/g, '')
    return { result, rls, constraints, triggers }
  }, { timeout: 60000 })
}
try {
  const [a,b] = await Promise.all([inventory(source), inventory(target)])
  const differences = a.result.filter((row,i) => JSON.stringify(row) !== JSON.stringify(b.result[i])).map(x=>x.table)
  const securityMatch = JSON.stringify(a.rls) === JSON.stringify(b.rls)
  if (!securityMatch) console.log(JSON.stringify({firstSecurityDifference:a.rls.map((row,i)=>({source:row,target:b.rls[i]})).find(x=>JSON.stringify(x.source)!==JSON.stringify(x.target))}))
  const constraintsMatch = JSON.stringify(a.constraints) === JSON.stringify(b.constraints)
  const triggersMatch = JSON.stringify(a.triggers) === JSON.stringify(b.triggers)
  console.log(JSON.stringify({ tables: a.result.length, destinationTables: b.result.length, allRowCountsAndHashesMatch: !differences.length, differences, securityMatch, constraintsMatch, triggersMatch, counts: a.result.filter(x=>['orders','ledger_entries','_prisma_migrations','receipt_documents','businesses'].includes(x.table)).map(({table,count})=>({table,count})) }))
  if (differences.length || a.result.length !== b.result.length || !securityMatch || !constraintsMatch || !triggersMatch) process.exitCode = 1
} finally { await Promise.all([source.$disconnect(),target.$disconnect()]) }
