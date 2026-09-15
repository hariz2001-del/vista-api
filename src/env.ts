import { z } from 'zod'

// Load .env ourselves rather than relying on a side effect of importing Prisma,
// which only happens to work because Prisma Client reads .env for its own
// datasource. Real values from the environment always win over the file.
try {
  process.loadEnvFile()
} catch {
  // No .env file — expected in production, where the values come from the
  // process environment (PM2, systemd, a container).
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // Long enough that a leaked short secret cannot be brute-forced offline.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * The only sites whose pages may call this API from a browser, comma
   * separated. Defaults to the local dev servers; production sets the counter
   * and dashboard domains.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:5180,http://localhost:5182')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  // Fail at boot rather than at the first request that needs the missing value.
  throw new Error(`Invalid environment:\n${issues}`)
}

export const env = parsed.data
