// Validate a full restore on the EMPTY destination, then ROLLBACK all imported objects/data.
// Apply mode requires the exact destination ref; production switching is separate.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { PrismaClient } from '@prisma/client'

const archivePath = process.argv[2]
const apply = process.argv[3] === '--apply' && process.argv[4] === 'xgahhzjzaibykseqmqhz'
if (process.argv[3] && !apply) throw new Error('Apply requires --apply xgahhzjzaibykseqmqhz')
if (!archivePath) throw new Error('Usage: node scripts/migration-rehearse.mjs <archive>')
const env = parseEnv(await readFile('.env.migration', 'utf8'))
const target = new URL(env.TARGET_DIRECT_URL)
if (decodeURIComponent(target.username) !== 'postgres.xgahhzjzaibykseqmqhz' || target.port !== '5432') throw new Error('Target identity guard failed')
const db = new PrismaClient({ datasources: { db: { url: env.TARGET_DIRECT_URL } }, log: [] })
try {
  const tables = await db.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'")
  if (tables[0].count !== 0) throw new Error('Rehearsal requires an empty destination')
  const archive = await readFile(archivePath)
  if (archive.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Invalid archive')
  const remote = `import sys,json,os,subprocess,tempfile,base64
c=json.load(sys.stdin)
e=os.environ.copy();e.update(c['env'])
data=base64.b64decode(c['archive'])
toc=subprocess.run(['pg_restore','--list'],input=data,capture_output=True,check=True).stdout.decode()
# Keep application ACLs/RLS and postgres defaults. Supabase owns its admin defaults.
toc='\\n'.join(line for line in toc.splitlines() if not (' SCHEMA - public ' in line or (' DEFAULT ACL ' in line and line.endswith(' supabase_admin'))))
with tempfile.NamedTemporaryFile(mode='w',suffix='.toc') as f:
 f.write(toc);f.flush()
 dump=subprocess.run(['pg_restore','--no-owner','--file=-','--use-list='+f.name],input=data,capture_output=True)
 if dump.returncode: sys.exit('Archive SQL conversion failed')
 sql=b'BEGIN;\\nSET LOCAL lock_timeout=\\x2715s\\x27;\\n'+dump.stdout+(b'\\nCOMMIT;\\n' if c['apply'] else b'\\nROLLBACK;\\n')
 result=subprocess.run(['psql','-X','--set=ON_ERROR_STOP=on','--file=-'],input=sql,env=e,capture_output=True)
 if result.returncode:
  # Database errors may echo SQL containing private values; return only error categories.
  errors=[line for line in result.stderr.decode(errors='replace').splitlines() if 'ERROR:' in line]
  print(json.dumps({'ok':False,'errors':errors}));sys.exit(1)
 print(json.dumps({'ok':True,'rolledBack':not c['apply'],'archiveSqlBytes':len(dump.stdout)}))`
  const child = spawn('ssh', ['vps-hermes', `python3 -c '${remote.replaceAll("'", "'\\''")}'`], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { error += chunk.toString() })
  const done = new Promise((accept, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? accept() : reject(new Error(`Rehearsal failed (${code}); ${output || 'diagnostic suppressed'}`)))
  })
  child.stdin.end(JSON.stringify({ apply, archive: archive.toString('base64'), env: {
    PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: target.pathname.slice(1),
    PGUSER: decodeURIComponent(target.username), PGPASSWORD: decodeURIComponent(target.password),
    PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15',
  } }))
  await done
  const afterTables = await db.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'")
  if (afterTables[0].count !== (apply ? 57 : 0)) throw new Error('Post-restore table verification failed')
  console.log(JSON.stringify({ result: JSON.parse(output), destinationTables: afterTables[0].count, warnings: Boolean(error) }))
} finally { await db.$disconnect() }
