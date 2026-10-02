import { randomInt } from 'node:crypto'
import { hashSecret } from '../auth.ts'
import type { Tx } from '../db.ts'

/** A random 4-digit PIN from the operating system's CSPRNG, leading zeros kept. */
export function generatePin(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0')
}

/**
 * Give a staff member a new PIN. Only its hash is stored, so the plain PIN
 * exists exactly once — in the response to whoever set it.
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
  const secretHash = await hashSecret(pin)
  await tx.staffCredential.upsert({
    where: { staffId_kind: { staffId, kind: 'PIN' } },
    update: { secretHash, setAt: new Date() },
    create: { businessId, staffId, kind: 'PIN', secretHash },
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
