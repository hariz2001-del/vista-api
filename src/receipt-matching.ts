/** Legal suffixes are not vendor identity (BFEE SDN BHD != Speed Mart SDN BHD). */
export function sameVendor(a: string | null, b: string | null): boolean {
  const words = (s: string | null) => [...new Set((s ?? '').toLowerCase().split(/\W+/).filter(w => w.length > 1 && !['sdn', 'bhd', 'supply', 'trading', 'enterprise', 'company', 'co', 'ltd', 'inc'].includes(w)))]
  const x = words(a), y = words(b)
  if (!x.length || !y.length) return false
  const common = x.filter(w => y.includes(w)).length
  return common / new Set([...x, ...y]).size >= 0.6
}
