import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './build-app.ts'

// Vercel's entrypoint detection picks src/app.ts ahead of src/server.ts, and it
// wraps this file with its Node serverless launcher — which invokes the default
// export as a plain (req, res) handler. A Fastify instance is an object, not a
// function, so exporting the app directly leaves the request unanswered; the
// instance has to be bridged onto its own http server instead.
//
// src/server.ts stays the local entrypoint and still listens on a real port.
const app: FastifyInstance = await buildApp()
await app.ready()

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app.server.emit('request', req, res)
}
