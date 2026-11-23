import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { badRequest } from '../errors.ts'

/**
 * Connection details for a campaign's order source (e.g. a Google refresh
 * token) are sealed with AES-256-GCM before they reach the database, so a
 * database dump alone does not hand them out. The key is CAMPAIGN_SECRET_KEY,
 * any long random string, hashed to 32 bytes. Sealed values never leave the
 * server: routes report only whether one is set.
 */

const VERSION = 'v1'

function key(): Buffer {
  const raw = process.env.CAMPAIGN_SECRET_KEY
  if (!raw || raw.length < 32) throw badRequest('campaign:SECRET_KEY_MISSING')
  return createHash('sha256').update(raw).digest()
}

export function sealSecret(value: Record<string, string>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.')
}

export function openSecret(sealed: string): Record<string, string> {
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || !body) throw new Error('campaign secret: unknown format')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const text = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  return JSON.parse(text) as Record<string, string>
}
