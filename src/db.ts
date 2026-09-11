import { PrismaClient } from '@prisma/client'

/**
 * One client for the process. Prisma manages its own connection pool; creating
 * a second client would create a second pool and quietly halve the headroom.
 */
export const prisma = new PrismaClient()

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>
