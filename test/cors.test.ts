import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.ts'
import { makeApp } from './helpers.ts'

/**
 * Every other suite calls the API with inject(), which never sends a browser's
 * CORS preflight. That is how a PATCH-and-PUT-blocking default passed every test
 * and still broke the owner dashboard's menu and settings in a real browser.
 * These send the preflight a browser would.
 */

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

function preflight(url: string, method: string) {
  return app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin: 'http://localhost:5174',
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type',
    },
  })
}

describe('cors preflight', () => {
  it.each([
    ['/rms/products/00000000-0000-4000-8000-000000000000', 'PATCH'],
    ['/rms/settings', 'PUT'],
    ['/rms/expenses', 'POST'],
    ['/rms/snapshot', 'GET'],
  ])('lets a browser send %s as %s', async (url, method) => {
    const response = await preflight(url, method)

    expect(response.statusCode).toBe(204)
    // The header reads "GET, HEAD, POST, …" — trim, or " PATCH" never equals "PATCH".
    const allowed = String(response.headers['access-control-allow-methods'] ?? '')
      .split(',')
      .map((name) => name.trim())
    expect(allowed).toContain(method)
  })

  it('gives a page on any other site nothing to work with', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/rms/snapshot',
      headers: {
        origin: 'https://not-vista.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })

    const allowedOrigin = response.headers['access-control-allow-origin']
    expect(allowedOrigin).not.toBe('https://not-vista.example')
    expect(allowedOrigin).not.toBe('*')
  })
})
