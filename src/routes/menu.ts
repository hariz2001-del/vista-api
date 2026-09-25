import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireOwner } from '../auth.ts'
import type { Tx } from '../db.ts'
import { badRequest, conflict, notFound } from '../errors.ts'

/**
 * The menu builder, from the owner dashboard.
 *
 * A new business starts with one brand, one category and nothing to sell; this
 * is where it builds the rest. Every query goes through `request.db`, so an id
 * from another business reads as not found.
 *
 * Nothing here can rewrite a sale. Order lines snapshot the name, price and
 * brand they were rung up with, and anything that has been sold cannot be
 * deleted — the `Restrict` foreign keys refuse it — only hidden.
 */

const ID = z.string().uuid()
const NAME = z.string().trim().min(1).max(80)
const COLOUR = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const PRICE = z.number().int().min(0).max(10_000_000)

const brandCreate = z.object({ name: NAME, colour: COLOUR })
const brandUpdate = z.object({ name: NAME.optional(), colour: COLOUR.optional() })

const categoryCreate = z.object({ brandId: ID, name: NAME })
const categoryUpdate = z.object({ name: NAME })

const productCreate = z.object({
  categoryId: ID,
  name: NAME,
  description: z.string().trim().max(200).default(''),
  basePriceSen: PRICE,
  imageUrl: z.string().trim().url().max(500).nullish(),
  /** Option groups of other items to copy onto the new one, e.g. the category's usual sizes. */
  copyGroupIds: z.array(ID).max(20).default([]),
})

const groupCopy = z.object({ groupId: ID })
const productUpdate = z.object({
  categoryId: ID.optional(),
  name: NAME.optional(),
  description: z.string().trim().max(200).optional(),
  basePriceSen: PRICE.optional(),
  imageUrl: z.string().trim().url().max(500).nullish(),
  isSoldOut: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

const groupCreate = z.object({
  name: NAME,
  minSelect: z.number().int().min(0).max(20),
  maxSelect: z.number().int().min(1).max(20),
})
const groupUpdate = groupCreate.partial()

const optionCreate = z.object({
  name: NAME,
  priceSen: PRICE.default(0),
  type: z.enum(['ADD_ON', 'REMOVAL']).default('ADD_ON'),
})
const optionUpdate = optionCreate.partial().extend({ isSoldOut: z.boolean().optional() })

/** The pale version of a brand colour the counter uses behind its badges. */
function softColourOf(hex: string): string {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16)
    return Math.round(value + (255 - value) * 0.88)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

/** Translate the database's refusals into what the owner needs to hear. */
function translate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique name within its brand or business.
    if (error.code === 'P2002') throw conflict('menu:NAME_TAKEN')
    // A Restrict foreign key: it has been sold, or still has things in it.
    if (error.code === 'P2003') throw conflict('menu:IN_USE')
  }
  throw error
}

function assertSelection(minSelect: number, maxSelect: number): void {
  if (minSelect > maxSelect) throw badRequest('menu:INVALID_SELECTION')
}

/**
 * Copy an option group, with all its options, onto a product. The copy is its
 * own group: editing the original later does not change it, and a past sale's
 * modifiers keep pointing at the options it was actually sold with.
 *
 * `tx` is business-scoped, so a group id from another business reads as not
 * found. Goes last among the product's groups.
 */
async function copyGroup(
  tx: Tx,
  businessId: string,
  sourceGroupId: string,
  productId: string,
): Promise<string> {
  const source = await tx.modifierGroup.findUnique({
    where: { id: sourceGroupId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })
  if (!source) throw notFound('menu:GROUP_NOT_FOUND')

  const count = await tx.modifierGroup.count({ where: { productId } })
  const copy = await tx.modifierGroup.create({
    data: {
      businessId,
      productId,
      name: source.name,
      description: source.description,
      minSelect: source.minSelect,
      maxSelect: source.maxSelect,
      sortOrder: count + 1,
      items: {
        create: source.items.map((item) => ({
          name: item.name,
          priceSen: item.priceSen,
          type: item.type,
          sortOrder: item.sortOrder,
        })),
      },
    },
  })
  return copy.id
}

type Params = { Params: { id: string } }

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: requireOwner }

  // -------------------------------------------------------------------------
  // Brands
  // -------------------------------------------------------------------------

  app.post('/rms/brands', owner, async (request) => {
    const body = brandCreate.parse(request.body)
    const { db, businessId } = request
    const last = await db.brand.findFirst({ orderBy: { sortOrder: 'desc' } })
    const brand = await db.brand
      .create({
        data: {
          businessId,
          name: body.name,
          colour: body.colour,
          softColour: softColourOf(body.colour),
          sortOrder: (last?.sortOrder ?? 0) + 1,
        },
      })
      .catch(translate)
    return { id: brand.id }
  })

  app.patch<Params>('/rms/brands/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = brandUpdate.parse(request.body)
    const { db } = request
    if (!(await db.brand.findUnique({ where: { id } }))) throw notFound('menu:BRAND_NOT_FOUND')
    await db.brand
      .update({
        where: { id },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.colour === undefined
            ? {}
            : { colour: body.colour, softColour: softColourOf(body.colour) }),
        },
      })
      .catch(translate)
    return { id }
  })

  app.delete<Params>('/rms/brands/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    if (!(await db.brand.findUnique({ where: { id } }))) throw notFound('menu:BRAND_NOT_FOUND')
    if ((await db.brand.count()) <= 1) throw conflict('menu:LAST_BRAND')
    await db.brand.delete({ where: { id } }).catch(translate)
    return { id }
  })

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  app.post('/rms/categories', owner, async (request) => {
    const body = categoryCreate.parse(request.body)
    const { db, businessId } = request
    if (!(await db.brand.findUnique({ where: { id: body.brandId } }))) {
      throw notFound('menu:BRAND_NOT_FOUND')
    }
    const last = await db.category.findFirst({ orderBy: { sortOrder: 'desc' } })
    const category = await db.category
      .create({
        data: {
          businessId,
          brandId: body.brandId,
          name: body.name,
          sortOrder: (last?.sortOrder ?? 0) + 1,
        },
      })
      .catch(translate)
    return { id: category.id }
  })

  app.patch<Params>('/rms/categories/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = categoryUpdate.parse(request.body)
    const { db } = request
    if (!(await db.category.findUnique({ where: { id } }))) {
      throw notFound('menu:CATEGORY_NOT_FOUND')
    }
    await db.category.update({ where: { id }, data: { name: body.name } }).catch(translate)
    return { id }
  })

  app.delete<Params>('/rms/categories/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    if (!(await db.category.findUnique({ where: { id } }))) {
      throw notFound('menu:CATEGORY_NOT_FOUND')
    }
    await db.category.delete({ where: { id } }).catch(translate)
    return { id }
  })

  // -------------------------------------------------------------------------
  // Products
  // -------------------------------------------------------------------------

  app.post('/rms/products', owner, async (request) => {
    const body = productCreate.parse(request.body)
    const { db, businessId } = request
    const category = await db.category.findUnique({ where: { id: body.categoryId } })
    if (!category) throw notFound('menu:CATEGORY_NOT_FOUND')

    // The item and any option groups copied onto it land together or not at all.
    return db.$transaction(async (tx) => {
      const last = await tx.product.findFirst({ orderBy: { sortOrder: 'desc' } })
      const product = await tx.product
        .create({
          data: {
            businessId,
            brandId: category.brandId,
            categoryId: category.id,
            name: body.name,
            description: body.description,
            basePriceSen: body.basePriceSen,
            imageUrl: body.imageUrl ?? null,
            sortOrder: (last?.sortOrder ?? 0) + 1,
          },
        })
        .catch(translate)
      for (const groupId of new Set(body.copyGroupIds)) {
        await copyGroup(tx, businessId, groupId, product.id)
      }
      return { id: product.id }
    })
  })

  /** Copy another item's option group, with its options, onto this item. */
  app.post<Params>('/rms/products/:id/groups/copy', owner, async (request) => {
    const productId = ID.parse(request.params.id)
    const { groupId } = groupCopy.parse(request.body)
    const { db, businessId } = request
    return db.$transaction(async (tx) => {
      if (!(await tx.product.findUnique({ where: { id: productId } }))) {
        throw notFound('rms:PRODUCT_NOT_FOUND')
      }
      return { id: await copyGroup(tx, businessId, groupId, productId) }
    })
  })

  /**
   * Edit an item. A price change reaches the counter on its next menu refresh;
   * a sale already rung at the old price is recorded at the price charged,
   * never repriced. Moving it to another category moves it to that category's
   * brand for future sales only.
   */
  app.patch<Params>('/rms/products/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = productUpdate.parse(request.body)
    const { db } = request
    if (Object.values(body).every((value) => value === undefined)) {
      throw badRequest('rms:NOTHING_TO_CHANGE')
    }

    if (!(await db.product.findUnique({ where: { id } }))) {
      throw notFound('rms:PRODUCT_NOT_FOUND')
    }

    let moveTo: { categoryId: string; brandId: string } | undefined
    if (body.categoryId !== undefined) {
      const category = await db.category.findUnique({ where: { id: body.categoryId } })
      if (!category) throw notFound('menu:CATEGORY_NOT_FOUND')
      moveTo = { categoryId: category.id, brandId: category.brandId }
    }

    await db.product
      .update({
        where: { id },
        data: {
          ...moveTo,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.basePriceSen === undefined ? {} : { basePriceSen: body.basePriceSen }),
          ...(body.imageUrl === undefined ? {} : { imageUrl: body.imageUrl }),
          ...(body.isSoldOut === undefined ? {} : { isSoldOut: body.isSoldOut }),
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        },
      })
      .catch(translate)
    return { id }
  })

  app.delete<Params>('/rms/products/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    if (!(await db.product.findUnique({ where: { id } }))) {
      throw notFound('rms:PRODUCT_NOT_FOUND')
    }
    // Refused by the order_items foreign key once it has ever been sold.
    await db.product.delete({ where: { id } }).catch(translate)
    return { id }
  })

  // -------------------------------------------------------------------------
  // Option groups and options
  // -------------------------------------------------------------------------

  app.post<Params>('/rms/products/:id/groups', owner, async (request) => {
    const productId = ID.parse(request.params.id)
    const body = groupCreate.parse(request.body)
    assertSelection(body.minSelect, body.maxSelect)
    const { db, businessId } = request
    if (!(await db.product.findUnique({ where: { id: productId } }))) {
      throw notFound('rms:PRODUCT_NOT_FOUND')
    }
    const count = await db.modifierGroup.count({ where: { productId } })
    const group = await db.modifierGroup.create({
      data: {
        businessId,
        productId,
        name: body.name,
        minSelect: body.minSelect,
        maxSelect: body.maxSelect,
        sortOrder: count + 1,
      },
    })
    return { id: group.id }
  })

  app.patch<Params>('/rms/groups/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = groupUpdate.parse(request.body)
    const { db } = request
    const group = await db.modifierGroup.findUnique({ where: { id } })
    if (!group) throw notFound('menu:GROUP_NOT_FOUND')
    assertSelection(body.minSelect ?? group.minSelect, body.maxSelect ?? group.maxSelect)
    await db.modifierGroup.update({ where: { id }, data: body })
    return { id }
  })

  /** Deleting a group takes its options with it; past sales keep their snapshot. */
  app.delete<Params>('/rms/groups/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    if (!(await db.modifierGroup.findUnique({ where: { id } }))) {
      throw notFound('menu:GROUP_NOT_FOUND')
    }
    await db.modifierGroup.delete({ where: { id } })
    return { id }
  })

  app.post<Params>('/rms/groups/:id/options', owner, async (request) => {
    const modifierGroupId = ID.parse(request.params.id)
    const body = optionCreate.parse(request.body)
    const { db, businessId } = request
    if (!(await db.modifierGroup.findUnique({ where: { id: modifierGroupId } }))) {
      throw notFound('menu:GROUP_NOT_FOUND')
    }
    const count = await db.modifierItem.count({ where: { modifierGroupId } })
    const option = await db.modifierItem.create({
      data: {
        businessId,
        modifierGroupId,
        name: body.name,
        priceSen: body.priceSen,
        type: body.type,
        sortOrder: count + 1,
      },
    })
    return { id: option.id }
  })

  app.patch<Params>('/rms/options/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const body = optionUpdate.parse(request.body)
    const { db } = request
    if (!(await db.modifierItem.findUnique({ where: { id } }))) {
      throw notFound('menu:OPTION_NOT_FOUND')
    }
    await db.modifierItem.update({ where: { id }, data: body })
    return { id }
  })

  /** A sold option's history keeps its snapshotted name and price. */
  app.delete<Params>('/rms/options/:id', owner, async (request) => {
    const id = ID.parse(request.params.id)
    const { db } = request
    if (!(await db.modifierItem.findUnique({ where: { id } }))) {
      throw notFound('menu:OPTION_NOT_FOUND')
    }
    await db.modifierItem.delete({ where: { id } })
    return { id }
  })

  // -------------------------------------------------------------------------
  // Order — what drag and drop in the menu builder saves
  // -------------------------------------------------------------------------

  /** Categories, in the order the counter shows them. Every category, each once. */
  app.put('/rms/categories/order', owner, async (request) => {
    const { ids } = orderBody.parse(request.body)
    const { db } = request
    return db.$transaction(async (tx) => {
      const existing = await tx.category.findMany({ select: { id: true } })
      assertSameSet(ids, existing.map((row) => row.id))
      await saveOrder(ids, (id, sortOrder) => tx.category.update({ where: { id }, data: { sortOrder } }))
      return { ids }
    })
  })

  /**
   * The items of one category, in order. An item from another category in the
   * list moves here — dragged across — and with it to this category's brand,
   * for future sales only. Every item already here must be in the list, so a
   * stale screen cannot drop one by leaving it out.
   */
  app.put<Params>('/rms/categories/:id/products', owner, async (request) => {
    const categoryId = ID.parse(request.params.id)
    const { ids } = orderBody.parse(request.body)
    const { db } = request
    return db.$transaction(async (tx) => {
      const category = await tx.category.findUnique({ where: { id: categoryId } })
      if (!category) throw notFound('menu:CATEGORY_NOT_FOUND')

      const listed = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true } })
      if (listed.length !== new Set(ids).size || listed.length !== ids.length) {
        throw badRequest('menu:ORDER_MISMATCH')
      }
      const here = await tx.product.findMany({ where: { categoryId }, select: { id: true } })
      const inList = new Set(ids)
      if (here.some((row) => !inList.has(row.id))) throw badRequest('menu:ORDER_MISMATCH')

      await saveOrder(ids, (id, sortOrder) =>
        tx.product.update({
          where: { id },
          data: { sortOrder, categoryId: category.id, brandId: category.brandId },
        }),
      )
      return { ids }
    })
  })

  /** An item's option groups, in order. */
  app.put<Params>('/rms/products/:id/groups/order', owner, async (request) => {
    const productId = ID.parse(request.params.id)
    const { ids } = orderBody.parse(request.body)
    const { db } = request
    return db.$transaction(async (tx) => {
      if (!(await tx.product.findUnique({ where: { id: productId } }))) {
        throw notFound('rms:PRODUCT_NOT_FOUND')
      }
      const existing = await tx.modifierGroup.findMany({ where: { productId }, select: { id: true } })
      assertSameSet(ids, existing.map((row) => row.id))
      await saveOrder(ids, (id, sortOrder) => tx.modifierGroup.update({ where: { id }, data: { sortOrder } }))
      return { ids }
    })
  })

  /** A group's options, in order. */
  app.put<Params>('/rms/groups/:id/options/order', owner, async (request) => {
    const modifierGroupId = ID.parse(request.params.id)
    const { ids } = orderBody.parse(request.body)
    const { db } = request
    return db.$transaction(async (tx) => {
      if (!(await tx.modifierGroup.findUnique({ where: { id: modifierGroupId } }))) {
        throw notFound('menu:GROUP_NOT_FOUND')
      }
      const existing = await tx.modifierItem.findMany({ where: { modifierGroupId }, select: { id: true } })
      assertSameSet(ids, existing.map((row) => row.id))
      await saveOrder(ids, (id, sortOrder) => tx.modifierItem.update({ where: { id }, data: { sortOrder } }))
      return { ids }
    })
  })
}

const orderBody = z.object({ ids: z.array(ID).min(1).max(500) })

/** The new order must name exactly what is there: nothing added, nothing left out, nothing twice. */
function assertSameSet(ids: string[], existing: string[]): void {
  const listed = new Set(ids)
  if (
    listed.size !== ids.length ||
    listed.size !== existing.length ||
    existing.some((id) => !listed.has(id))
  ) {
    throw badRequest('menu:ORDER_MISMATCH')
  }
}

/** Positions from 1, in list order. One at a time: they share a transaction. */
async function saveOrder(
  ids: string[],
  write: (id: string, sortOrder: number) => Promise<unknown>,
): Promise<void> {
  for (const [index, id] of ids.entries()) await write(id, index + 1)
}
