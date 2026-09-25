import type { FastifyInstance } from 'fastify'
import { requireUser } from '../auth.ts'
import { businessDateToUtc, businessToday } from '../domain/business-date.ts'
import { serialisePromotion } from './promotions.ts'

/**
 * Everything the terminal needs to run a shift, in one response.
 *
 * This is what the tablet caches so it can keep selling with no network, so it
 * deliberately includes sold-out and inactive state — an offline device must be
 * able to grey out an item it could not otherwise know about.
 */
export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bootstrap', { preHandler: requireUser }, async (request) => {
    const db = request.db
    const today = await businessToday(db, request.businessId)
    // From yesterday: a shift open past midnight still trades on the date it opened.
    const yesterday = new Date(businessDateToUtc(today).getTime() - 24 * 60 * 60_000)
    const [brands, categories, products, openShift, settings, user, promotions] = await Promise.all([
      db.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      db.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      db.product.findMany({
        where: { isActive: true },
        // The owner's order: categories as arranged in the RMS, then items within each.
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
        include: {
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { items: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      }),
      db.shift.findFirst({ where: { status: 'OPEN' } }),
      db.accountSettings.findUnique({ where: { businessId: request.businessId } }),
      db.user.findUnique({ where: { id: request.user.id } }),
      // Switched on and not over. The tablet shows the ones running on its
      // shift's date, so a cached menu keeps working offline across days.
      db.promotion.findMany({
        where: { isActive: true, OR: [{ endsOn: null }, { endsOn: { gte: yesterday } }] },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ])

    return {
      business_date: today,
      promotions: promotions.map((promotion) => {
        const wire = serialisePromotion(promotion)
        return {
          id: wire.id,
          name: wire.name,
          kind: wire.kind,
          value: wire.value,
          starts_on: wire.startsOn,
          ends_on: wire.endsOn,
        }
      }),
      // Which business this device is signed in to. The tablet files its unsent
      // sales under it, so a device later signed in to another business never
      // sends them into the wrong books.
      business_id: request.businessId,
      // Who is signed in, so the counter can show their name without asking again.
      user: user ? { id: user.id, name: user.name, role: user.role } : null,
      // The business profile, so the sign-in and shift screens name the real outlet.
      account: settings
        ? {
            business_name: settings.businessName,
            outlet_name: settings.outletName,
            // The counter works out its own business date offline, so it needs the hour.
            day_rollover_hour: settings.dayRolloverHour,
          }
        : null,
      open_shift: openShift
        ? {
            id: openShift.id,
            business_date: openShift.businessDate.toISOString().slice(0, 10),
            opened_at: openShift.openedAt.toISOString(),
          }
        : null,
      brands: brands.map((brand) => ({
        id: brand.id,
        name: brand.name,
        colour: brand.colour,
        soft_colour: brand.softColour,
      })),
      categories: categories.map((category) => ({
        id: category.id,
        brand_id: category.brandId,
        name: category.name,
      })),
      products: products.map((product) => ({
        id: product.id,
        brand_id: product.brandId,
        category_id: product.categoryId,
        name: product.name,
        description: product.description,
        unit_price_sen: product.basePriceSen,
        image_url: product.imageUrl,
        sold_out: product.isSoldOut,
        modifier_groups: product.modifierGroups.map((group) => ({
          id: group.id,
          name: group.name,
          description: group.description,
          min_select: group.minSelect,
          max_select: group.maxSelect,
          options: group.items.map((item) => ({
            id: item.id,
            name: item.name,
            price_sen: item.priceSen,
            type: item.type,
            sold_out: item.isSoldOut,
          })),
        })),
      })),
    }
  })
}
