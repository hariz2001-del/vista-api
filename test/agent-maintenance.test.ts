import type { FastifyInstance } from 'fastify'
import { beforeAll,afterAll,it,expect } from 'vitest'
import {makeApp,makeBusiness,authed} from './helpers.ts'
import {prisma} from '../src/db.ts'
let app:FastifyInstance
beforeAll(async()=>{app=await makeApp()})
afterAll(async()=>{await app.close();await prisma.$disconnect()})
async function setup(){
  const b=await makeBusiness(app),headers=authed(b.ownerToken)
  const key=(await app.inject({method:'POST',url:'/rms/agent/keys',headers,payload:{label:'maintenance'}})).json().key
  for(const [telegramUserId,role] of [['111','OWNER'],['222','BOOKKEEPER']])await app.inject({method:'POST',url:'/rms/agent/users',headers,payload:{telegramUserId,role,name:role}})
  const call=(method:any,url:string,payload?:any,user='111')=>app.inject({method,url,payload,headers:{authorization:`Bearer ${key}`,'x-telegram-user':user}})
  const ok=async(method:any,url:string,payload?:any,user='111')=>{const r=await call(method,url,payload,user);expect(r.statusCode,r.body).toBe(200);return r.json()}
  let n=0
  const upload=async()=>(await ok('POST','/agent/receipts',{imageBase64:Buffer.from(`${b.businessId}:${n++}`).toString('base64'),deferProcessing:true})).receipt.id
  const brand=await prisma.brand.findFirstOrThrow({where:{businessId:b.businessId}})
  const expense=(await app.inject({method:'POST',url:'/rms/expenses',headers,payload:{businessDate:'2026-10-10',amountSen:1000,category:'RAW_MATERIALS',paidBy:'STALL_FUNDS',brandId:brand.id,foodSplitPct:100,description:'Original'}})).json().id
  return {b,headers,call,ok,upload,expense}
}
it('owner previews then corrects expense through actual RMS accounting with replay protection',async()=>{
  const s=await setup(),path=`/agent/expenses/${s.expense}/edit`
  const preview=await s.ok('POST',path+'/preview',{amountSen:1500,description:'Corrected',paymentMethod:'BANK_TRANSFER'})
  expect(preview.before.amountSen).toBe(1000);expect(preview.after.amountSen).toBe(1500)
  expect((await prisma.expense.findUniqueOrThrow({where:{id:s.expense}})).amountSen).toBe(1000)
  expect((await s.ok('POST',path+'/confirm',{confirmationId:preview.confirmationId})).saved).toBe(true)
  expect((await prisma.expense.findUniqueOrThrow({where:{id:s.expense}})).amountSen).toBe(1500)
  const rows=await prisma.ledgerEntry.findMany({where:{businessId:s.b.businessId}})
  expect(rows.reduce((sum,r)=>sum+(r.direction==='MONEY_OUT'?-r.amountSen:r.amountSen),0)).toBe(-1500)
  expect((await s.call('POST',path+'/confirm',{confirmationId:preview.confirmationId})).statusCode).toBe(409)
  expect(await prisma.expense.count({where:{businessId:s.b.businessId}})).toBe(1)
})
it('rejects partner access, cross-business IDs, stale previews and closed/locked records',async()=>{
  const s=await setup(),other=await setup(),path=`/agent/expenses/${s.expense}/edit`
  expect((await s.call('POST',path+'/preview',{description:'No'},'222')).statusCode).toBe(403)
  expect((await other.call('GET',path)).statusCode).toBe(404)
  const p=await s.ok('POST',path+'/preview',{description:'Proposal'})
  await prisma.expense.update({where:{id:s.expense},data:{notes:'Concurrent change'}})
  expect((await s.call('POST',path+'/confirm',{confirmationId:p.confirmationId})).statusCode).toBe(409)
  await prisma.expense.update({where:{id:s.expense},data:{isLocked:true}})
  const locked=await s.ok('POST',path+'/preview',{description:'Locked'})
  expect((await s.call('POST',path+'/confirm',{confirmationId:locked.confirmationId})).statusCode).toBe(409)
})
it('cleans only explicitly reused duplicate cache and keeps canonical metadata/evidence and expenses',async()=>{
  const s=await setup(),canonical=await s.upload(),duplicate=await s.upload()
  expect((await s.call('POST',`/agent/receipts/${canonical}/cleanup/preview`,{})).statusCode).toBe(409)
  await s.ok('POST',`/agent/receipts/${duplicate}/reuse`,{canonicalId:canonical,reason:'Confirmed same paper, canonical original retained'})
  const path=`/agent/receipts/${duplicate}/cleanup`,p=await s.ok('POST',path+'/preview',{})
  expect(p.canonicalReceiptId).toBe(canonical)
  expect((await s.call('POST',path+'/confirm',{confirmationId:p.confirmationId},'222')).statusCode).toBe(403)
  const result=await s.ok('POST',path+'/confirm',{confirmationId:p.confirmationId})
  expect(result.vista).toContain('metadata/audit retained')
  expect(await prisma.receiptImage.findUnique({where:{receiptId:duplicate}})).toBeNull()
  expect(await prisma.receiptImage.findUnique({where:{receiptId:canonical}})).not.toBeNull()
  expect(await prisma.receiptDocument.findUnique({where:{id:duplicate}})).not.toBeNull()
  expect((await s.call('GET',`/agent/receipts/${duplicate}/image`)).statusCode).toBe(409)
  expect(await prisma.expense.count({where:{businessId:s.b.businessId}})).toBe(1)
})
it('refuses cleanup if source becomes linked or canonical evidence is lost',async()=>{
  const s=await setup(),canonical=await s.upload(),duplicate=await s.upload()
  await s.ok('POST',`/agent/receipts/${duplicate}/reuse`,{canonicalId:canonical,reason:'Confirmed duplicate'})
  const path=`/agent/receipts/${duplicate}/cleanup`,p=await s.ok('POST',path+'/preview',{})
  await prisma.expense.update({where:{id:s.expense},data:{receiptDocumentId:duplicate}})
  expect((await s.call('POST',path+'/confirm',{confirmationId:p.confirmationId})).statusCode).toBe(409)
  expect(await prisma.receiptImage.findUnique({where:{receiptId:duplicate}})).not.toBeNull()
  await prisma.expense.update({where:{id:s.expense},data:{receiptDocumentId:null}})
  await prisma.receiptImage.delete({where:{receiptId:canonical}})
  expect((await s.call('POST',path+'/preview',{})).statusCode).toBe(409)
})
