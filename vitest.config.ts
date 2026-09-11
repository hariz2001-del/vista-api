import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // The integration tests share one Postgres database and assert on absolute
    // state (queue numbers, row counts). Running them in parallel would make
    // them interfere with each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    env: { NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
