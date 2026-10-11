import http from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ssh = (command, input) => execFileSync('ssh', ['vps-hermes', command], { input, encoding: 'utf8', maxBuffer: 1024 * 1024 })
const existing = JSON.parse(ssh('sudo cat /var/lib/sarang/drive/token.json'))
const state = randomBytes(24).toString('hex')
const verifier = randomBytes(32).toString('base64url')
const redirect = 'http://localhost:8765'
const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
auth.search = new URLSearchParams({ client_id: existing.client_id, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive', access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
async function setEnv(name, value) {
  const command = `npx vercel env update ${name} production --yes --scope aztechdigital`
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd, stdio: ['pipe', 'ignore', 'pipe'] })
  child.stdin.end(value)
  let error = ''
  child.stderr.on('data', (chunk) => { error += chunk })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code) throw new Error(`Vercel could not update ${name}. Check CLI login.`)
  console.log(`Updated ${name} in vista-api Production.`)
}
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, redirect)
  if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid sign-in state'); return }
  if (!url.searchParams.has('code')) { response.end('Sign-in was not completed. You can retry the link.'); return }
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: existing.client_id, client_secret: existing.client_secret, code: url.searchParams.get('code'), redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) })
    const token = await tokenResponse.json()
    if (!tokenResponse.ok || !token.refresh_token) throw new Error(`Google sign-in failed: ${token.error ?? 'no refresh token'}`)
    const renewed = { ...existing, refresh_token: token.refresh_token, token: token.access_token, expiry: new Date(Date.now() + token.expires_in * 1000).toISOString(), scopes: ['https://www.googleapis.com/auth/drive'] }
    execFileSync('scp', [path.join(cwd, 'hermes', 'connect-drive.py'), 'vps-hermes:/tmp/vista-connect-drive.py'], { stdio: 'ignore' })
    console.log(ssh('sudo python3 /tmp/vista-connect-drive.py', JSON.stringify(renewed)).trim())
    for (const [name, value] of [['GOOGLE_CLIENT_ID', renewed.client_id], ['GOOGLE_CLIENT_SECRET', renewed.client_secret], ['GOOGLE_REFRESH_TOKEN', renewed.refresh_token]]) await setEnv(name, value)
    response.end('Google Drive is connected to marketing and finance. You can close this tab and return to Codex.')
    console.log('OAUTH_COMPLETE')
    server.close()
  } catch (error) {
    console.error(error.message)
    response.writeHead(500).end('Sign-in failed. Return to Codex for the error details.')
  }
})
server.listen(8765, '127.0.0.1', () => { console.log(`Google consent: ${auth}`); console.log('Waiting for Google sign-in on localhost:8765.') })
setTimeout(() => { console.log('Google consent timed out; rerun this helper to reconnect.'); server.close() }, 30 * 60 * 1000).unref()
