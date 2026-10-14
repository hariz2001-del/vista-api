// Read-only source backup. No restore, deployment, or production configuration writes.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

const env = parseEnv(await readFile('.env.production', 'utf8'))
const source = new URL(env.DIRECT_URL)
if (!source.hostname.endsWith('.supabase.com') || !['postgres.kjjbijhszwpiyicoftls', 'postgres.xgahhzjzaibykseqmqhz'].includes(decodeURIComponent(source.username)) || source.port !== '5432') {
  throw new Error('Source identity guard failed')
}
const folder = resolve('../../backups', `vista-migration-prep-${new Date().toISOString().replaceAll(':', '-')}`)
await mkdir(folder, { recursive: false })
const archive = resolve(folder, 'public.dump')
// Secrets are sent over SSH stdin, never process arguments or remote files.
const remote = `import sys,json,os,subprocess
c=json.load(sys.stdin)
e=os.environ.copy()
e.update(c['env'])
sys.exit(subprocess.call(['pg_dump','--format=custom','--schema=public','--no-owner','--lock-wait-timeout=15s'],env=e))`
const command = `python3 -c '${remote.replaceAll("'", "'\\''")}'`
const child = spawn('ssh', ['vps-hermes', command], { stdio: ['pipe', 'pipe', 'pipe'] })
let error = ''
child.stderr.on('data', chunk => { error += chunk.toString() })
const done = new Promise((accept, reject) => {
  child.on('error', reject)
  child.on('close', code => code === 0 ? accept() : reject(new Error(`Backup failed (${code}); diagnostic retained in memory, not printed`)))
})
child.stdin.end(JSON.stringify({ env: {
  PGHOST: source.hostname, PGPORT: source.port, PGDATABASE: source.pathname.slice(1),
  PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password),
  PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15',
} }))
await Promise.all([pipeline(child.stdout, createWriteStream(archive, { flags: 'wx' })), done])
const bytes = await readFile(archive)
if (bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Invalid backup archive')
console.log(JSON.stringify({ archive, bytes: (await stat(archive)).size, sha256: createHash('sha256').update(bytes).digest('hex'), warnings: Boolean(error) }))
