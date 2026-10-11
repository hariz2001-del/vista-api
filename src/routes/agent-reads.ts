import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { businessToday } from '../domain/business-date.ts'

/**
 * Sarang AI's read-only questions: sales, expenses, stock, cash and the
 * receipt audit. Viewers may ask all of these; nothing here writes.
 *
 * Sales come from the cash book (REVENUE in, REFUND out), which already counts
 * cancellations and exchanges, so they agree with the RMS figures. Item
 * rankings come from the sold lines themselves.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const rangeQuery = z.object({ from: DATE.optional(), to: DATE.optional() })

const asDate = (value: string) => new Date(`${value}T00:00:00Z`)
const iso = (value: Date) => value.toISOString().slice(0, 10)
const addDays = (value: string, days: number) => iso(new Date(asDate(value).getTime() + days * 86_400_000))

/** A range, defaulting to the last 7 business days up to today. */
async function range(db: Parameters<typeof businessToday>[0], businessId: string, query: unknown) {
  const parsed = rangeQuery.parse(query)
  const today = await businessToday(db, businessId)
  const to = parsed.to ?? today
  const from = parsed.from ?? addDays(to, -6)
  return { from, to, gte: asDate(from), lte: asDate(to) }
}

export async function agentReadRoutes(app: FastifyInstance): Promise<void> {
  const viewer = { preHandler: requireAgent('VIEWER') }

  app.get('/agent/sales', viewer, async (request) => {
    const { db, businessId } = request
    const { from, to, gte, lte } = await range(db, businessId, request.query)
    const [brands, ledger, orders, items] = await Promise.all([
      db.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.ledgerEntry.findMany({
        where: { businessDate: { gte, lte }, category: { in: ['REVENUE', 'REFUND'] } },
        select: { businessDate: true, brandId: true, direction: true, amountSen: true },
      }),
      db.order.groupBy({ by: ['businessDate'], where: { businessDate: { gte, lte } }, _count: { _all: true } }),
      db.orderItem.findMany({
        where: { order: { businessDate: { gte, lte } } },
        select: {
          productName: true,
          brandId: true,
          quantity: true,
          unitPriceSen: true,
          modifierTotalSen: true,
          lineDiscountSen: true,
          allocatedOrderDiscountSen: true,
          category: { select: { name: true } },
        },
      }),
    ])
    const brandName = (id: string | null) => brands.find((brand) => brand.id === id)?.name ?? 'Unassigned'
    const days = new Map<string, { date: string; orders: number; netSen: number; byBrand: Record<string, number> }>()
    for (let day = from; day <= to; day = addDays(day, 1)) days.set(day, { date: day, orders: 0, netSen: 0, byBrand: {} })
    for (const row of ledger) {
      const day = days.get(iso(row.businessDate))
      if (!day) continue
      const signed = row.direction === 'MONEY_IN' ? row.amountSen : -row.amountSen
      day.netSen += signed
      const name = brandName(row.brandId)
      day.byBrand[name] = (day.byBrand[name] ?? 0) + signed
    }
    for (const group of orders) {
      const day = days.get(iso(group.businessDate))
      if (day) day.orders = group._count._all
    }
    const ranking = new Map<string, { name: string; brand: string; category: string; qty: number; netSen: number }>()
    for (const item of items) {
      const key = `${item.brandId}:${item.productName}`
      const row = ranking.get(key) ?? { name: item.productName, brand: brandName(item.brandId), category: item.category.name, qty: 0, netSen: 0 }
      row.qty += item.quantity
      row.netSen += (item.unitPriceSen + item.modifierTotalSen) * item.quantity - item.lineDiscountSen - item.allocatedOrderDiscountSen
      ranking.set(key, row)
    }
    const list = [...days.values()]
    const byBrand: Record<string, number> = {}
    for (const day of list) for (const [name, sen] of Object.entries(day.byBrand)) byBrand[name] = (byBrand[name] ?? 0) + sen
    return {
      from,
      to,
      totals: { netSen: list.reduce((sum, day) => sum + day.netSen, 0), orders: list.reduce((sum, day) => sum + day.orders, 0), byBrand },
      days: list,
      topItems: [...ranking.values()].toSorted((a, b) => b.netSen - a.netSen).slice(0, 20),
      note: 'Net sales are after discounts, cancellations and exchanges (from the cash book). Item figures are as rung up, before later corrections.',
    }
  })

  app.get('/agent/expenses', viewer, async (request) => {
    const { db, businessId } = request
    const { from, to, gte, lte } = await range(db, businessId, request.query)
    const [brands, rows] = await Promise.all([
      db.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.expense.findMany({ where: { businessDate: { gte, lte } }, orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }] }),
    ])
    const [first, second] = brands
    const byCategory: Record<string, number> = {}
    for (const row of rows) byCategory[row.category] = (byCategory[row.category] ?? 0) + row.amountSen
    return {
      from,
      to,
      totals: {
        amountSen: rows.reduce((sum, row) => sum + row.amountSen, 0),
        [`${first?.name ?? 'first'}Sen`]: rows.reduce((sum, row) => sum + row.foodAmountSen, 0),
        [`${second?.name ?? 'second'}Sen`]: rows.reduce((sum, row) => sum + row.drinksAmountSen, 0),
        byCategory,
        withoutReceipt: rows.filter((row) => !row.receiptDocumentId && !row.receiptUrl).length,
      },
      expenses: rows.map((row) => ({
        id: row.id,
        date: iso(row.businessDate),
        amountSen: row.amountSen,
        category: row.category,
        brand: row.brandId ? (brands.find((brand) => brand.id === row.brandId)?.name ?? '?') : 'Shared',
        firstBrandSharePct: row.foodSplitPct,
        paidBy: row.paidBy,
        paymentMethod: row.paymentMethod,
        reimbursed: row.paidBy === 'STALL_FUNDS' ? null : row.isSettled,
        vendor: row.vendor,
        receiptNo: row.receiptNo,
        description: row.description,
        hasReceiptPhoto: Boolean(row.receiptDocumentId || row.receiptUrl),
      })),
    }
  })

  app.get('/agent/stock/latest', viewer, async (request) => {
    const count = await request.db.stockCount.findFirst({
      orderBy: [{ businessDate: 'desc' }, { submittedAt: 'desc' }],
      include: { lines: { orderBy: { position: 'asc' } } },
    })
    if (!count) return { count: null }
    const pct: Record<string, number> = { EMPTY: 0, QUARTER: 25, LESS_THAN_HALF: 25, HALF: 50, THREE_QUARTERS: 75, MORE_THAN_HALF: 75, FULL: 100 }
    return {
      count: {
        date: iso(count.businessDate),
        submittedAt: count.submittedAt.toISOString(),
        countedBy: count.staffName,
        remarks: count.remarks,
        lines: count.lines.map((line) => {
          const balance = line.balance ? pct[line.balance] : null
          const noneSealed = !line.trackUnopened || line.unopenedMilli === 0
          return {
            brand: line.brandName,
            category: line.category,
            name: line.name,
            unit: line.unitLabel,
            unopened: line.trackUnopened && line.unopenedMilli !== null ? line.unopenedMilli / 1000 : null,
            openedBalancePct: line.trackBalance ? balance : null,
            note: noneSealed && balance === 0 ? 'Finished stock' : noneSealed && balance === 25 ? 'Low stock' : null,
          }
        }),
      },
    }
  })

  /**
   * The stall's own money as the books see it, for comparing with a bank
   * balance. Partner-paid expenses never left the stall: they are a debt to
   * that partner until reimbursed, listed separately.
   */
  app.get('/agent/cash', viewer, async (request) => {
    const { db } = request
    const [moneyIn, moneyOut, owed, brands, partners, lastEntries] = await Promise.all([
      db.ledgerEntry.aggregate({ where: { direction: 'MONEY_IN' }, _sum: { amountSen: true } }),
      db.ledgerEntry.aggregate({ where: { direction: 'MONEY_OUT' }, _sum: { amountSen: true } }),
      db.expense.groupBy({ by: ['paidBy'], where: { paidBy: { not: 'STALL_FUNDS' }, isSettled: false }, _sum: { amountSen: true }, _count: { _all: true } }),
      db.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.partner.findMany(),
      db.ledgerEntry.findMany({ orderBy: [{ businessDate: 'desc' }, { id: 'desc' }], take: 15 }),
    ])
    const [first, second] = brands
    const partnerName = (brandId: string | undefined) => partners.find((partner) => partner.brandId === brandId)?.name
    return {
      stallBalanceSen: (moneyIn._sum.amountSen ?? 0) - (moneyOut._sum.amountSen ?? 0),
      owedToPartners: owed.map((row) => {
        const brand = row.paidBy === 'PARTNER_FOOD' ? first : second
        return { partner: partnerName(brand?.id) ?? `${brand?.name ?? '?'} partner`, amountSen: row._sum.amountSen ?? 0, expenses: row._count._all }
      }),
      recentEntries: lastEntries.map((entry) => ({
        date: iso(entry.businessDate),
        direction: entry.direction,
        amountSen: entry.amountSen,
        category: entry.category,
        description: entry.description,
      })),
      note: 'Vista keeps one stall cash book (till cash plus the counter bank account together), not per-bank accounts. Compare a bank balance with stallBalanceSen, allowing for cash in the till, pending transfers and timing. Never adjust the books just to make them match.',
    }
  })

  /** What needs attention: expenses without a receipt photo, receipts not sorted, possible doubles. */
  app.get('/agent/audit', viewer, async (request) => {
    const { db, businessId } = request
    const { from, to, gte, lte } = await range(db, businessId, request.query)
    const [missing, open, rows] = await Promise.all([
      db.expense.findMany({
        where: { businessDate: { gte, lte }, receiptDocumentId: null, OR: [{ receiptUrl: null }, { receiptUrl: '' }], category: { not: 'WAGES' } },
        orderBy: { businessDate: 'asc' },
        select: { id: true, businessDate: true, amountSen: true, vendor: true, receiptNo: true, description: true, receiptDocumentId: true, brandId: true },
      }),
      db.receiptDocument.groupBy({ by: ['status'], where: { status: { in: ['UPLOADED', 'PENDING_REVIEW', 'SKIPPED'] } }, _count: { _all: true } }),
      db.expense.findMany({
        where: { businessDate: { gte, lte } },
        select: { id: true, businessDate: true, amountSen: true, vendor: true, receiptNo: true, description: true, receiptDocumentId: true, brandId: true },
      }),
    ])
    const seen = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = `${iso(row.businessDate)}|${row.amountSen}|${(row.vendor ?? '').toLowerCase()}|${(row.receiptNo ?? '').toLowerCase()}`
      seen.set(key, [...(seen.get(key) ?? []), row])
    }
    return {
      from,
      to,
      expensesWithoutReceipt: missing.map((row) => ({ ...row, businessDate: iso(row.businessDate) })),
      receiptsNotSorted: Object.fromEntries(open.map((group) => [group.status, group._count._all])),
      possibleDuplicates: [...seen.values()]
        .filter((group) => group.length > 1 && !(group.every(row => row.receiptDocumentId && row.receiptDocumentId === group[0]!.receiptDocumentId) && new Set(group.map(row => row.brandId)).size > 1))
        .map((group) => group.map((row) => ({ ...row, businessDate: iso(row.businessDate) }))),
      note: 'A missing photo does not make an expense wrong — it only means there is nothing on file to back it.',
    }
  })
}
