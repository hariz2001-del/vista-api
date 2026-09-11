import type { FastifyInstance } from 'fastify'
import { requireUser } from '../auth.ts'
import { prisma } from '../db.ts'
import { getBusinessDate } from '../domain/business-date.ts'

/**
 * Everything the terminal needs to run a shift, in one response.
 *
 * This is what the tablet caches so it can keep selling with no network, so it
 * deliberately includes sold-out and inactive state — an offline device must be
 * able to grey out an item it could not otherwise know about.
 */
export async function bootstrapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bootstrap', { preHandler: requireUser }, async () => {
    const [brands, categories, products, openShift] = await Promise.all([
      prisma.brand.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.category.findMany({ orderBy: [{ brandId: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.product.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { items: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      }),
      prisma.shift.findFirst({ where: { status: 'OPEN' } }),
    ])

    return {
      business_date: getBusinessDate(new Date()),
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
