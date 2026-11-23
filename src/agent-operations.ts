import type { FastifyInstance, RouteOptions } from 'fastify'
import { requireAgent } from './auth.ts'
import { DomainError } from './errors.ts'

/** Reuse the app's exact handlers and business rules, with independent agent guards. */
export function collectAgentOperations(app: FastifyInstance) {
  const routes: RouteOptions[] = []
  const allowedTeam = /^\/rms\/team\/(schedule-setup|operating-hours|closed-periods(?:\/:id)?|slot-templates|weeks(?:\/.*)?|slots(?:\/.*)?|assignments(?:\/.*)?|coverage(?:\/.*)?|staff|work-types|settings|attendance(?:\/.*)?|payroll(?:\/.*)?|audit)$/
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/agent/')) return
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    // Explicit owner-requested payroll bookkeeping, reusing the RMS transactions.
    // This records an already-made payment; it never initiates a bank transfer.
    const payrollWrite = route.url === '/rms/team/payroll/approve' || route.url === '/rms/team/payslips/:id/pay'
    const team = allowedTeam.test(route.url) || payrollWrite
    const stock = route.url.startsWith('/rms/stock/') || ['/stock/sheet', '/stock/counts'].includes(route.url)
    if (!team && !stock) return
    for (const method of methods) {
      if (method === 'HEAD') continue
      // Staff/payroll administration and payments need separate explicit tools;
      // this bridge exposes their reads and roster/stock actions only.
      const sensitive = /^\/rms\/team\/(staff|work-types|settings|attendance|payroll|audit)/.test(route.url)
      if (sensitive && method !== 'GET' && !payrollWrite) continue
      routes.push({
        method, url: route.url.replace(/^\/rms/, '').replace(/^\//, '/agent/'),
        schema: route.schema, handler: route.handler,
        onResponse: async (request, reply) => {
          if (method === 'GET' || reply.statusCode >= 400 || !request.agentUser) return
          await request.db.agentAction.create({ data: {
            businessId: request.businessId, agentUserId: request.agentUser.id,
            action: `operations.${method.toLowerCase()}`, entityType: stock ? 'stock' : 'team',
            entityId: (request.params as { id?: string }).id ?? 'setup',
            detail: JSON.parse(JSON.stringify({ path: request.routeOptions.url, params: request.params, body: request.body })),
          } })
        },
        preHandler: async (request, reply) => {
          await requireAgent(method === 'GET' && !sensitive ? 'VIEWER' : 'OWNER')(request, reply)
          if (payrollWrite) {
            const body = request.body as Record<string, unknown> | undefined
            if (!body || !Number.isSafeInteger(body.expectedTotalSen) || Number(body.expectedTotalSen) <= 0 ||
                (route.url.endsWith('/pay') && (body.confirmedAlreadyPaid !== true || typeof body.paidOn !== 'string'))) {
              throw new DomainError('agent:PAYROLL_CONFIRMATION_REQUIRED', 400, 'Use the reviewed expectedTotalSen; payment recording also requires paidOn and confirmedAlreadyPaid=true from the owner.')
            }
          }
          const owner = await request.db.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' } })
          if (!owner) throw new DomainError('agent:NO_OWNER', 409, 'The business has no active owner.')
          // Shared handlers use user.id for foreign keys; Telegram attribution
          // remains available in agentUser and the audit trail.
          request.user = { id: owner.id, email: owner.email, role: owner.role, sid: '', scope: 'OWNER' }
        },
      })
    }
  })
  return () => {
    for (const route of routes) app.route(route)
    app.get('/agent/operations', { preHandler: requireAgent('VIEWER') }, async () => ({
      routes: routes.map(({ method, url }) => ({ method, path: url })),
      note: 'Dates YYYY-MM-DD, times HH:MM in Malaysia. GET reads. Writes require OWNER and a user request. Payroll approve requires staffId,start,end,expectedTotalSen. Payslip pay only records an already-made payment: paidOn,expectedTotalSen,confirmedAlreadyPaid=true are required. Never initiates transfers. Payroll/staff reads require OWNER. Monetary API values are integer sen; stock quantities are thousandths.',
    }))
  }
}
