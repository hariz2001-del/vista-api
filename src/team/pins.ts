import { randomInt, timingSafeEqual } from 'node:crypto'
import { hashSecret, verifySecret } from '../auth.ts'
import type { Tx } from '../db.ts'
import { conflict } from '../errors.ts'
import { sealPin, unsealPin } from './seal.ts'

/** A random 4-digit PIN from the operating system's CSPRNG, leading zeros kept. */
export function generatePin(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0')
}

type PinCredential = { staffId: string; secretHash: string; secretSealed: string | null }

/**
 * The credentials, out of those given, whose PIN is this one. Staff sign in
 * with the PIN alone, so it is matched against everyone in the business: the
 * sealed copy is fast to check; a PIN set before copies were kept falls back
 * to its bcrypt hash.
 */
export async function pinMatches<T extends PinCredential>(credentials: T[], pin: string): Promise<T[]> {
  const typed = Buffer.from(pin)
  const matches: T[] = []
  for (const credential of credentials) {
    const known = unsealPin(credential.secretSealed)
    const same = known === null
      ? await verifySecret(pin, credential.secretHash)
      : known.length === pin.length && timingSafeEqual(Buffer.from(known), typed)
    if (same) matches.push(credential)
  }
  return matches
}

async function otherPins(tx: Tx, staffId: string | null): Promise<PinCredential[]> {
  return tx.staffCredential.findMany({
    where: { kind: 'PIN', ...(staffId ? { NOT: { staffId } } : {}) },
    select: { staffId: true, secretHash: true, secretSealed: true },
  })
}

/**
 * A random PIN nobody else in the business has. A PIN is the whole sign-in,
 * so two people can never share one.
 */
export async function uniquePin(tx: Tx, staffId: string | null = null): Promise<string> {
  const others = await otherPins(tx, staffId)
  for (let tries = 0; tries < 200; tries += 1) {
    const pin = generatePin()
    if ((await pinMatches(others, pin)).length === 0) return pin
  }
  throw conflict('team:PIN_TAKEN')
}

/**
 * Give a staff member a new PIN. Sign-in checks its bcrypt hash; an
 * encrypted copy lets management look it up again in the RMS (seal.ts).
 *
 * Every session that staff member has open is ended: a reset is usually
 * because the old PIN got out, so a phone signed in with it must not stay in.
 */
export async function setStaffPin(
  tx: Tx,
  businessId: string,
  staffId: string,
  pin: string,
): Promise<void> {
  if ((await pinMatches(await otherPins(tx, staffId), pin)).length > 0) throw conflict('team:PIN_TAKEN')
  const secretHash = await hashSecret(pin)
  const secretSealed = sealPin(pin)
  await tx.staffCredential.upsert({
    where: { staffId_kind: { staffId, kind: 'PIN' } },
    update: { secretHash, secretSealed, setAt: new Date() },
    create: { businessId, staffId, kind: 'PIN', secretHash, secretSealed },
  })
  await revokeStaffSessions(tx, staffId)
}

/** Sign a staff member out of every phone. */
export async function revokeStaffSessions(tx: Tx, staffId: string): Promise<void> {
  await tx.session.updateMany({
    where: { staffId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}
