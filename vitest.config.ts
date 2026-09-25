import { defineConfig } from 'vitest/config'

/**
 * The tests get their own database.
 *
 * They wipe every order, shift and ledger row before each test. Pointed at the
 * development database, one `npm test` would erase whatever was being tried out
 * by hand in the POS or RMS. So they run against `<dev database>_test` instead,
 * which `test/global-setup.ts` creates, migrates and seeds.
 *
 * Set `TEST_DATABASE_URL` to use a different one.
 */
try {
  process.loadEnvFile()
} catch {
  // No .env — CI supplies DATABASE_URL directly.
}

const devUrl = process.env.DATABASE_URL
if (!devUrl) throw new Error('DATABASE_URL is not set — copy .env.example to .env')

const testUrl = new URL(process.env.TEST_DATABASE_URL ?? devUrl)
if (!process.env.TEST_DATABASE_URL) testUrl.pathname = `${new URL(devUrl).pathname}_test`
if (testUrl.pathname === new URL(devUrl).pathname) {
  throw new Error('The test database must not be the development database.')
}

const seedPassword = process.env.SEED_PASSWORD
const seedPin = process.env.SEED_PIN
if (!seedPassword || !seedPin) {
  throw new Error('SEED_PASSWORD and SEED_PIN are not set — copy .env.example to .env')
}

// Set in this process, so global-setup and every test worker agree on one URL.
// The dev URL is kept separately only so global-setup can issue CREATE DATABASE.
process.env.VISTA_ADMIN_DATABASE_URL = devUrl
process.env.DATABASE_URL = testUrl.toString()
// Prisma Migrate connects through DIRECT_URL. Left pointing at the dev database,
// global-setup's `migrate deploy` would migrate that instead of the test one.
process.env.DIRECT_URL = testUrl.toString()

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './test/global-setup.ts',
    // The integration tests share one Postgres database and assert on absolute
    // state (queue numbers, row counts). Running them in parallel would make
    // them interfere with each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testUrl.toString(),
      SEED_PASSWORD: seedPassword,
      SEED_PIN: seedPin,
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
