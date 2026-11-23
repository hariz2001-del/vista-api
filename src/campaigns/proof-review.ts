import type { Tx } from '../db.ts'

/**
 * Turns what the reader saw on a payment screenshot into flags for the owner.
 * The rules are here, not in the model: the model only reports what it reads.
 * Flags never verify or reject anything; they say where to look.
 */

export type Extraction = {
  /** Does it look like a payment confirmation at all? */
  looksLikeReceipt: boolean
  /** Could the important parts be read? */
  readable: boolean
  provider: string | null
  /** YYYY-MM-DD as printed. */
  date: string | null
  /** HH:MM, 24-hour, as printed. */
  time: string | null
  amountSen: number | null
  reference: string | null
  recipient: string | null
  status: string | null
  /** Anything the reader found odd (edited-looking, failed, pending, wrong payee…). */
  concerns: string[]
}

export type Review = { flags: string[]; summary: string; duplicateOf: string[] }

function sameText(a: string | null, b: unknown): boolean {
  return !!a && typeof b === 'string' && a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()
}

const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Same payee, allowing for banks that cut the name short
 * ("Ahmad Farid Bin Abdul" vs "Ahmad Farid Bin Abdul Rahman Shah").
 */
export function samePayee(a: string, b: string): boolean {
  const [x, y] = [nameKey(a), nameKey(b)].sort((p, q) => p.length - q.length)
  return x!.length >= 8 && y!.startsWith(x!)
}

/**
 * The reader's note is only about who was paid (it cannot know the shop's
 * account holder). Notes about editing or a bad status are never this.
 */
const isPayeeConcern = (concern: string) =>
  /recipient|payee|beneficiar|personal name/i.test(concern) && !/edit|tamper|alter|fake|forg|crop|fail|pending|cancel|amount|date/i.test(concern)

/**
 * A payee the owner has already verified payments to, on this campaign. A shop
 * paid through a personal account (Sarang's DuitNow QR is in the owner's name)
 * would otherwise get "not clearly the shop" on every receipt.
 */
async function trustedPayee(db: Tx, campaignId: string, orderId: string, recipient: string | null): Promise<boolean> {
  if (!recipient) return false
  const verified = await db.campaignPaymentProof.findMany({
    where: { orderId: { not: orderId }, readStatus: 'DONE', order: { campaignId, verification: 'VERIFIED', deletedAt: null } },
    select: { extraction: true },
  })
  return verified.some((row) => {
    const other = ((row.extraction ?? {}) as Record<string, unknown>).recipient
    return typeof other === 'string' && samePayee(recipient, other)
  })
}

export async function reviewProof(
  db: Tx,
  input: { orderId: string; campaignId: string; expectedSen: number; submittedAt: Date; sha256: string | null; extraction: Extraction },
): Promise<Review> {
  const { extraction } = input
  const flags = new Set<string>()
  const notes: string[] = []

  if (!extraction.looksLikeReceipt) {
    flags.add('INVALID_IMAGE')
    notes.push('Does not look like a payment confirmation.')
  } else if (!extraction.readable || extraction.amountSen === null) {
    flags.add('UNREADABLE')
    notes.push('The amount could not be read.')
  }

  if (extraction.looksLikeReceipt && extraction.amountSen !== null && extraction.amountSen !== input.expectedSen) {
    flags.add('AMOUNT_MISMATCH')
    notes.push(`Paid RM ${(extraction.amountSen / 100).toFixed(2)}, expected RM ${(input.expectedSen / 100).toFixed(2)}.`)
  }

  // A payment dated after the order was submitted (beyond a day's slack) or long before it is odd.
  if (extraction.date) {
    const paid = Date.parse(`${extraction.date}T00:00:00+08:00`)
    const submitted = input.submittedAt.getTime()
    if (Number.isFinite(paid) && (paid > submitted + 24 * 3600_000 || paid < submitted - 30 * 24 * 3600_000)) {
      flags.add('FLAGGED')
      notes.push(`Payment date ${extraction.date} does not fit the order time.`)
    }
  }
  if (extraction.status && /fail|pending|unsuccess|reject|cancel/i.test(extraction.status)) {
    flags.add('FLAGGED')
    notes.push(`Status shows “${extraction.status}”.`)
  }
  let concerns = extraction.concerns
  if (concerns.some(isPayeeConcern) && (await trustedPayee(db, input.campaignId, input.orderId, extraction.recipient))) {
    concerns = concerns.filter((concern) => !isPayeeConcern(concern))
  }
  if (concerns.length) {
    flags.add('FLAGGED')
    notes.push(...concerns.slice(0, 3))
  }

  // Duplicates: the same file, or the same transfer reference, on another order of this business.
  const duplicateOf = new Set<string>()
  if (input.sha256) {
    const same = await db.campaignPaymentProof.findMany({
      where: { sha256: input.sha256, orderId: { not: input.orderId }, order: { deletedAt: null } },
      select: { order: { select: { externalRef: true } } },
    })
    for (const row of same) duplicateOf.add(row.order.externalRef)
  }
  if (extraction.reference && extraction.reference.replace(/\W/g, '').length >= 6) {
    const candidates = await db.campaignPaymentProof.findMany({
      where: { orderId: { not: input.orderId }, readStatus: 'DONE', order: { deletedAt: null } },
      select: { extraction: true, order: { select: { externalRef: true } } },
    })
    for (const row of candidates) {
      const other = (row.extraction ?? {}) as Record<string, unknown>
      if (sameText(extraction.reference, other.reference)) duplicateOf.add(row.order.externalRef)
    }
  }
  if (duplicateOf.size) {
    flags.add('POSSIBLE_DUPLICATE')
    notes.push(`Same proof or reference as ${[...duplicateOf].slice(0, 5).join(', ')}.`)
  }

  if (flags.size === 0) {
    flags.add('PASSED')
    notes.push('Looks like a payment of the right amount.')
  }
  return { flags: [...flags], summary: notes.join(' '), duplicateOf: [...duplicateOf] }
}
