import { PrismaClient } from '@prisma/client'

/**
 * One client for the process. Prisma manages its own connection pool; creating
 * a second client would create a second pool and quietly halve the headroom.
 *
 * Routes do not use this directly — they use `request.db`, the business-scoped
 * view below. Only sign-in and registration, which run before there is a
 * business to scope to, reach for the bare client.
 */
export const prisma = new PrismaClient()

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

/** Tables that belong to no business. Everything else carries `business_id`. */
const UNSCOPED_MODELS = new Set(['Business', 'AttemptCounter'])

/** Operations that read or change existing rows: they are filtered. */
const FILTERED = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
])

type Args = Record<string, unknown>

function stamp(data: unknown, businessId: string): unknown {
  return Array.isArray(data)
    ? data.map((row: Args) => ({ ...row, businessId }))
    : { ...(data as Args), businessId }
}

/**
 * The database as one business sees it.
 *
 * Every top-level query on a business-owned table is filtered to `businessId`,
 * and every row created is stamped with it — overriding anything the caller
 * passed, so a business id in a request body can never redirect a write.
 *
 * Only the top level needs it. Every relation between business-owned tables is
 * a composite foreign key on `(business_id, …)` (see schema.prisma), so an
 * `include` or a nested create starting from a scoped row cannot reach or make
 * a row of another business: the database refuses it.
 *
 * Raw SQL is not covered — `$queryRaw` never passes through here. Every raw
 * query in the routes filters on `business_id` itself.
 *
 * The extension only rewrites arguments and never changes a result type, so it
 * is returned as a plain PrismaClient and works everywhere a `Tx` does,
 * including inside `$transaction`.
 */
export function forBusiness(businessId: string): PrismaClient {
  if (!businessId) throw new Error('forBusiness: no business id')

  return prisma.$extends({
    name: 'business-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (UNSCOPED_MODELS.has(model)) return query(args)

          const scoped = { ...(args as Args) }
          if (FILTERED.has(operation)) {
            scoped.where = { ...(scoped.where as Args | undefined), businessId }
          } else if (
            operation === 'create' ||
            operation === 'createMany' ||
            operation === 'createManyAndReturn'
          ) {
            scoped.data = stamp(scoped.data, businessId)
          } else if (operation === 'upsert') {
            scoped.where = { ...(scoped.where as Args | undefined), businessId }
            scoped.create = stamp(scoped.create, businessId)
          } else {
            // A new Prisma operation this does not know how to scope. Refuse
            // rather than let it run across every business.
            throw new Error(`forBusiness: cannot scope ${model}.${operation}`)
          }
          return query(scoped as typeof args)
        },
      },
    },
  }) as unknown as PrismaClient
}
