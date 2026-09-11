/**
 * Money is an integer number of sen, everywhere, with no exceptions.
 *
 * The reason is the boundary, not the database: Postgres `numeric` is exact,
 * but it becomes a binary float the moment Node reads it. Integers stay exact
 * through Postgres, JSON and JavaScript alike.
 */

export function assertSen(value: number, fieldName = 'amount'): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer number of sen`)
  }
  return value
}

export function formatRinggit(sen: number): string {
  const checked = assertSen(sen)
  const ringgit = Math.trunc(checked / 100)
  const cents = checked % 100
  return `RM ${ringgit.toLocaleString('en-MY')}.${cents.toString().padStart(2, '0')}`
}

/**
 * Split `totalSen` across `weights` so the parts sum to exactly `totalSen`.
 *
 * Largest remainder: floor everyone, then hand the leftover sen to whoever was
 * rounded down hardest. Two properties matter and both are relied on elsewhere:
 *
 *  - the parts always sum to the whole, so no sen is invented or lost;
 *  - no part exceeds its own weight, so a discount can never push a line or a
 *    brand below zero.
 */
export function apportion(totalSen: number, weights: readonly number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  if (totalSen <= 0 || weightSum <= 0) return weights.map(() => 0)

  const exact = weights.map((weight) => (totalSen * weight) / weightSum)
  const shares = exact.map(Math.floor)
  let allocated = shares.reduce((sum, share) => sum + share, 0)

  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .toSorted((a, b) => b.remainder - a.remainder || a.index - b.index)

  for (const { index } of byRemainder) {
    if (allocated >= totalSen) break
    const current = shares[index]
    if (current === undefined) continue
    shares[index] = current + 1
    allocated += 1
  }

  return shares
}
