import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { authed, makeApp, makeBusiness } from './helpers.ts'
import { prisma } from '../src/db.ts'
let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await app.close(); await prisma.$disconnect() })
async function setup() {
 const b = await makeBusiness(app), headers = authed(b.ownerToken)
 const key = (await app.inject({ method: 'POST', url: '/rms/agent/keys', headers, payload: { label: 'coupons' } })).json().key
 for (const [id, role] of [['111','OWNER'],['222','BOOKKEEPER']]) await app.inject({ method: 'POST', url: '/rms/agent/users', headers, payload: { telegramUserId: id, role, name: role } })
 const call = (url: string, payload: object, user = '111') => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${key}`, 'x-telegram-user': user } })
 const ok = async (url: string, payload: object) => { const r = await call(url, payload); expect(r.statusCode,r.body).toBe(200); return r.json() }
 await app.inject({ method: 'POST', url: '/rms/balance-checks', headers, payload: { businessDate: '2026-11-02', bankSen: 134972 } })
 const owner = await prisma.user.findFirstOrThrow({ where: { businessId: b.businessId, role: 'OWNER' } })
 for (const [day, sales, expense, interest] of [['2026-11-03',40900,10300,0],['2026-11-04',17600,7580,10]] as const) {
  for (const [direction, category, amountSen] of [['MONEY_IN','REVENUE',sales],['MONEY_OUT','OPERATING_EXPENSE',expense],['MONEY_IN','BANK_INTEREST',interest]] as const) if (amountSen) await prisma.ledgerEntry.create({ data: { businessId:b.businessId,businessDate:new Date(day),direction,category,amountSen,description:category } })
  await prisma.expense.create({ data: { businessId:b.businessId,businessDate:new Date(day),amountSen:expense,category:'ICE_GAS',paidBy:'STALL_FUNDS',description:'Existing expense',foodSplitPct:100,foodAmountSen:expense,drinksAmountSen:0,createdById:owner.id,receiptUrl:'https://example.com/evidence' } })
 }
 for (const input of [{businessDate:'2026-11-03',salesSen:40900,expensesSen:10300,openingBankSen:134972,statedTotalSen:165572,closingBankSen:163172},{businessDate:'2026-11-04',salesSen:17600,expensesSen:7580,interestSen:10,closingBankSen:175602}]) {const p=await ok('/agent/closing/preview',input);await ok('/agent/closing/confirm',{confirmationId:p.confirmationId})}
 const body={businessDate:'2026-11-03',amountSen:2400,description:'Owner confirmed unclaimed coupon sales',confirmedCouponSale:true,salesAlreadyRecorded:true}
 return {b,call,ok,body}
}
it('defers a coupon sale from bank cash, collects on its actual later date, and never doubles sales, expenses or cash entries',async()=>{
 const s=await setup(), path='/agent/coupon-claims'
 const before=await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})
 const responses=await Promise.all([s.call(path,s.body),s.call(path,s.body)])
 for(const r of responses)expect(r.statusCode,r.body).toBe(200)
 expect(responses.map(r=>r.json().replayed).sort()).toEqual([false,true])
 const saved=responses.find(r=>!r.json().replayed)!.json(),claim=saved.claim
 expect(claim.detail).toMatchObject({paymentStatus:'UNPAID',outstandingSen:2400})
 expect(saved.closings[0].detail.comparison.lines.closingBank).toMatchObject({shortSen:0,vistaExpectedSen:163172})
 expect(saved.closings[0].detail.flags).not.toContain('CLOSING_ARITHMETIC_DIFFERENCE')
 expect(saved.closings[0].detail.comparison.lines.arithmetic).toMatchObject({ownTotalSen:163172,totalDifferenceSen:0})
 const collected=await s.ok(path+'/collect',{claimId:claim.id,receivedDate:'2026-11-04',amountSen:2400,confirmedAlreadyReceived:true})
 expect(collected.claim.detail).toMatchObject({paymentStatus:'RECEIVED',outstandingSen:0,evidenceStatus:'AWAITING_PAYMENT_EVIDENCE'})
 const nov4=collected.closings.find((c:any)=>c.detail.input.businessDate==='2026-11-04')
 expect(nov4.detail.comparison.lines.closingBank).toMatchObject({shortSen:0,vistaExpectedSen:175602})
 expect(nov4.detail.flags).toContain('AWAITING_COUPON_PAYMENT_EVIDENCE')
 expect(await s.ok(path+'/collect',{claimId:claim.id,receivedDate:'2026-11-04',amountSen:2400,confirmedAlreadyReceived:true})).toMatchObject({replayed:true})
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})).toBe(before+2)
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId,category:'REVENUE'}})).toBe(2)
 expect(await prisma.expense.count({where:{businessId:s.b.businessId}})).toBe(2)
 await prisma.chopperStash.create({data:{businessId:s.b.businessId,telegramUser:'111',receiptKey:'R-ABC123',data:{fileId:'coupon-bank-file',scanVerified:true,transferDirection:'MONEY_IN',reading:{date:'2026-11-04',totalSen:2400}}}})
 const linked=await s.ok(path+'/collect',{claimId:claim.id,receivedDate:'2026-11-04',amountSen:2400,confirmedAlreadyReceived:true,receiptKey:'R-ABC123'})
 expect(linked.claim.detail.evidenceStatus).toBe('ATTACHED')
 expect(linked.closings.find((c:any)=>c.detail.input.businessDate==='2026-11-04')!.detail.flags).not.toContain('AWAITING_COUPON_PAYMENT_EVIDENCE')
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})).toBe(before+2)
})
it('requires owner instruction, isolates businesses, rejects conflicting totals or unconfirmed payment and never invents a collection',async()=>{
 const s=await setup(),path='/agent/coupon-claims'
 expect((await s.call(path,s.body,'222')).statusCode).toBe(403)
 expect((await s.call(path,{...s.body,confirmedCouponSale:false})).statusCode).toBe(400)
 expect((await s.call(path,{...s.body,amountSen:999999})).statusCode).toBe(409)
 const claim=(await s.ok(path,s.body)).claim
 expect((await s.call(path,{...s.body,amountSen:2500})).statusCode).toBe(409)
 const payload={claimId:claim.id,receivedDate:'2026-11-04',amountSen:2400,confirmedAlreadyReceived:true}
 expect((await s.call(path+'/collect',{...payload,confirmedAlreadyReceived:false})).statusCode).toBe(400)
 expect((await s.call(path+'/collect',{...payload,receivedDate:'2026-11-02'})).statusCode).toBe(409)
 expect((await s.call(path+'/collect',{...payload,receiptKey:'R-FFFFFF'})).statusCode).toBe(409)
 const other=await setup();expect((await other.call(path+'/collect',payload)).statusCode).toBe(404)
 const rows=await prisma.ledgerEntry.findMany({where:{businessId:s.b.businessId,category:'RECONCILIATION_ADJUSTMENT'}})
 expect(rows).toHaveLength(1);expect(rows[0]!.description).toContain('NOT a bank payment')
})
it('saves an older paid claim without inventing its sale date, and asks sales inclusion before adding cash',async()=>{
 const s=await setup(),path='/agent/coupon-claims/prior-collection'
 const before=await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})
 const body={receivedDate:'2026-11-03',amountSen:2400,description:'Owner confirms older coupon paid into Sarang on 3 November; no screenshot',confirmedAlreadyReceived:true}
 const pending=await s.ok(path,body)
 expect(pending.claim.detail).toMatchObject({paymentStatus:'RECEIVED',outstandingSen:0,sourceClaimDate:null,classificationStatus:'AWAITING_SALES_INCLUSION',evidenceStatus:'AWAITING_PAYMENT_EVIDENCE'})
 expect(pending.cashBookPosted).toBe(false)
 expect(pending.closings[0].detail.flags).toContain('COUPON_SALES_INCLUSION_PENDING')
 expect(pending.closings[0].detail.comparison.lines.closingBank.shortSen).toBe(-2400)
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})).toBe(before)
 const included=await s.ok(path,{...body,includedInSales:true})
 expect(included.claim.id).toBe(pending.claim.id)
 expect(included.cashBookPosted).toBe(false)
 expect(included.closings[0].detail.comparison.lines.coupons.alreadyIncludedInSalesSen).toBe(2400)
 expect(included.closings[0].detail.flags).not.toContain('COUPON_SALES_INCLUSION_PENDING')
 expect(included.closings[0].detail.flags).toContain('AWAITING_COUPON_PAYMENT_EVIDENCE')
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})).toBe(before)
 expect((await s.call(path,{...body,includedInSales:false})).statusCode).toBe(409)
 const replay=await s.ok(path,body);expect(replay.claim.detail.includedInSales).toBe(true)
})
it('posts a separately received older coupon exactly once and reports the real larger shortfall rather than clearing it',async()=>{
 const s=await setup(),path='/agent/coupon-claims/prior-collection'
 const body={receivedDate:'2026-11-03',amountSen:2400,description:'Coupon claim from before, now received separately from sales',confirmedAlreadyReceived:true,includedInSales:false}
 const before=await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})
 const responses=await Promise.all([s.call(path,body),s.call(path,body)])
 for(const r of responses)expect(r.statusCode,r.body).toBe(200)
 const result=responses[0]!.json()
 expect(result.cashBookPosted).toBe(true)
 expect(result.claim.detail).toMatchObject({sourceClaimDate:null,paymentStatus:'RECEIVED',evidenceStatus:'AWAITING_PAYMENT_EVIDENCE'})
 expect(result.closings[0].detail.comparison.lines.closingBank).toMatchObject({vistaExpectedSen:167972,closingSen:163172,shortSen:-4800,differenceDirection:'SHORT'})
 expect(result.closings[0].detail.flags).toContain('BANK_DIFFERENCE')
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId}})).toBe(before+1)
 expect(await prisma.ledgerEntry.count({where:{businessId:s.b.businessId,category:'REVENUE'}})).toBe(2)
 expect(await prisma.reconciliationCase.count({where:{businessId:s.b.businessId,kind:'COUPON_RECEIVABLE'}})).toBe(0)
 expect((await s.call(path,{...body,confirmedAlreadyReceived:false})).statusCode).toBe(400)
 expect((await s.call(path,{...body,amountSen:2500})).statusCode).toBe(409)
})
