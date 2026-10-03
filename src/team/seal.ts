import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { env } from '../env.ts'

/**
 * Reversible encryption for staff PINs, so management can look one up in the
 * RMS behind the eye button. Sign-in never uses this — it checks the bcrypt
 * hash, as before.
 *
 * AES-256-GCM, with a key derived from the server's JWT secret for this one
 * purpose (HKDF, its own label), so nothing new has to be configured and the
 * key never sits in the database beside what it locks. Rotating the JWT secret
 * makes existing PINs unreadable: they then show as "reset to see", and still
 * work for sign-in.
 */

const VERSION = 'v1'

function key(): Buffer {
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, 'vista-team', 'staff-pin-seal-v1', 32))
}

export function sealPin(pin: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join('.')
}

/** The PIN, or null if it was sealed under another key or is not ours. */
export function unsealPin(sealed: string | null): string | null {
  if (!sealed) return null
  const [version, iv, tag, body] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || !body) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
