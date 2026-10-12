import type {FastifyInstance} from 'fastify'
import {beforeAll,afterAll,it,expect,vi} from 'vitest'
import sharp from 'sharp'
import {createHash} from 'node:crypto'
import {prisma,forBusiness} from '../src/db.ts'
import {makeApp,makeBusiness,authed} from './helpers.ts'
import {env} from '../src/env.ts'
import {retainBulkScanOnly} from '../src/integrations/drive.ts'
let app:FastifyInstance
beforeAll(async()=>{app=await makeApp()})
afterAll(async()=>{await app.close();await prisma.$disconnect()})
async function setup(){
  const b=await makeBusiness(app),owner=authed(b.ownerToken)
  const key=(await app.inject({method:'POST',url:'/rms/agent/keys',headers:owner,payload:{label:'bulk'}})).json().key
  for(const [telegramUserId,role] of [['111','OWNER'],['222','BOOKKEEPER'],['333','VIEWER']])await app.inject({method:'POST',url:'/rms/agent/users',headers:owner,payload:{telegramUserId,role,name:role}})
  const call=(method:any,url:string,payload?:any,user='111')=>app.inject({method,url,payload,headers:{authorization:`Bearer ${key}`,'x-telegram-user':user}})
  const ok=async(method:any,url:string,payload?:any,user='111')=>{const r=await call(method,url,payload,user);expect(r.statusCode,r.body).toBe(200);return r.json()}
  let n=0
  const upload=async()=> (await ok('POST','/agent/receipts',{imageBase64:Buffer.from(`${b.businessId}:${n++}`).toString('base64'),deferProcessing:true})).receipt.id
  return {b,call,ok,upload}
}
it('bulk commands are persistent/idempotent/actor bound and only new bulk sources opt into scan-only',async()=>{
  const s=await setup(),historical=await s.upload()
  const started=await s.ok('POST','/agent/inbox/bulk/start',{})
  expect((await s.ok('POST','/agent/inbox/bulk/start',{})).bulkId).toBe(started.bulkId)
  expect((await s.ok('GET','/agent/inbox/settings',undefined,'222')).bulk).toBe(false)
  const id=await s.upload(),receipt=await prisma.receiptDocument.findUniqueOrThrow({where:{id}})
  expect(receipt.status).toBe('SKIPPED');expect((receipt.extracted as any)._inbox).toMatchObject({bulkId:started.bulkId,scanOnly:true,suppressNotification:true,scanOnlyAuthorisedBy:receipt.uploadedById})
  await s.ok('POST','/agent/receipts',{imageBase64:Buffer.from(`${s.b.businessId}:0`).toString('base64'),deferProcessing:true})
  expect((await prisma.receiptDocument.findUniqueOrThrow({where:{id:historical}})).extracted).toBeNull()
  const ended=await s.ok('POST','/agent/inbox/bulk/end',{})
  expect(ended).toMatchObject({bulk:false,autoStash:false,bulkId:started.bulkId})
  const list=await s.ok('POST','/agent/inbox/review',{scope:'batch'})
  expect(list.entries.map((e:any)=>e.id)).toEqual([id,historical])
  expect(list.pendingCount).toBe(2)
  expect((await s.call('POST','/agent/inbox/bulk/start',{},'333')).statusCode).toBe(403)
})
it('waits for processing, then leases one end-bulk list to the stored actual actor',async()=>{
  const s=await setup(),bulk=await s.ok('POST','/agent/inbox/bulk/start',{}),id=await s.upload()
  expect((await s.ok('POST','/agent/inbox/bulk/ready',{bulkId:bulk.bulkId})).delivery).toBeNull()
  await s.ok('POST','/agent/inbox/bulk/end',{})
  expect((await s.ok('POST','/agent/inbox/bulk/ready',{bulkId:bulk.bulkId})).pending).toBe(1)
  // Terminal failure is represented in the list, never silently omitted.
  await prisma.receiptJob.update({where:{receiptId:id},data:{status:'FAILED'}})
  const ready=await s.ok('POST','/agent/inbox/bulk/ready',{bulkId:bulk.bulkId})
  expect(ready.delivery.chatId).toBe('111');expect(ready.delivery.result.entries[0].id).toBe(id)
  expect((await s.ok('POST','/agent/inbox/bulk/ready',{bulkId:bulk.bulkId})).delivery).toBeNull()
  expect((await s.ok('POST','/agent/inbox/bulk/ready',{bulkId:bulk.bulkId},'222')).delivery).toBeNull()
  await s.ok('POST','/agent/inbox/bulk/delivered',{id:ready.delivery.id,leaseToken:ready.delivery.leaseToken,messageId:42})
  expect((await s.ok('POST','/agent/inbox/bulk/ready',{bulkId:bulk.bulkId})).delivery).toBeNull()
})
it('preserves colour in actual perspective crop',async()=>{
  const s=await setup(),image=await sharp({create:{width:120,height:200,channels:3,background:'#c02020'}}).png().toBuffer()
  const id=(await s.ok('POST','/agent/receipts',{imageBase64:image.toString('base64'),mimeType:'image/png',deferProcessing:true})).receipt.id
  await s.ok('POST',`/agent/receipts/${id}/scan`,{corners:[{x:.05,y:.05},{x:.95,y:.05},{x:.95,y:.95},{x:.05,y:.95}]})
  const stored=await prisma.receiptImage.findUniqueOrThrow({where:{receiptId:id}})
  const {data,info}=await sharp(Buffer.from(stored.scanBytes!)).raw().toBuffer({resolveWithObject:true})
  expect(info.channels).toBe(3);expect(data[0]!).toBeGreaterThan(data[1]!+40)
})
it('verifies scan readback before trashing original, switches canonical image and never applies retroactively',async()=>{
  const s=await setup(),historic=await s.upload()
  expect(await retainBulkScanOnly(forBusiness(s.b.businessId),historic)).toMatchObject({notRequested:true})
  await s.ok('POST','/agent/inbox/bulk/start',{});const id=await s.upload()
  const jpeg=await sharp({create:{width:100,height:200,channels:3,background:'#cc8844'}}).jpeg().toBuffer(),hash=createHash('sha256').update(jpeg).digest('hex')
  const source=await prisma.receiptDocument.findUniqueOrThrow({where:{id}})
  await prisma.receiptDocument.update({where:{id},data:{driveFileId:'original-file',driveUrl:'https://drive.test/original',scanDriveFileId:'scan-file',scanDriveUrl:'https://drive.test/scan',totalSen:1000,extracted:{...source.extracted as any,lines:[{name:'Item',qty:1,unit_price_rm:10,amount_rm:10}],scan:{style:'colour',sha256:hash,corners:[{}, {}, {}, {}]}}}})
  const keys=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','DRIVE_FINANCES_FOLDER_ID','DRIVE_BUSINESS_ID'] as const
  const before=Object.fromEntries(keys.map(k=>[k,env[k]]));Object.assign(env,{GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REFRESH_TOKEN:'test',DRIVE_FINANCES_FOLDER_ID:'finances-root',DRIVE_BUSINESS_ID:s.b.businessId})
  let trashed=false,badScan=true;const writes:string[]=[]
  vi.stubGlobal('fetch',async(url:string,init:any={})=>{
    if(url.includes('oauth2'))return new Response(JSON.stringify({access_token:'test-only',expires_in:3600}))
    const file=url.split('/files/')[1]?.split('?')[0]
    if(url.includes('alt=media'))return new Response(badScan?Buffer.from('invalid'):jpeg)
    if(init.method==='PATCH'){writes.push(file!);trashed=true}
    return new Response(JSON.stringify(file==='finances-root'?{id:file,mimeType:'application/vnd.google-apps.folder'}:{id:file,name:file,mimeType:'image/jpeg',parents:['finances-root'],webViewLink:'https://drive.test/scan',appProperties:{vistaReceiptId:id,...(file==='scan-file'?{vistaVariant:'scan'}:{})},trashed:file==='original-file'&&trashed}))
  })
  try{
    await expect(retainBulkScanOnly(forBusiness(s.b.businessId),id)).rejects.toThrow();expect(writes).toHaveLength(0)
    badScan=false;expect((await retainBulkScanOnly(forBusiness(s.b.businessId),id)).retired).toBe(true)
    expect(writes).toEqual(['original-file'])
    const kept=await prisma.receiptDocument.findUniqueOrThrow({where:{id}})
    expect(kept.driveFileId).toBe('scan-file');expect((kept.extracted as any)._inbox.originalRetired).toBe(true)
    expect(await prisma.receiptImage.findUnique({where:{receiptId:id}})).toBeNull()
    const read=(await s.ok('GET',`/agent/receipts/${id}/image?original=true`)).imageBase64
    expect(Buffer.from(read,'base64')).toEqual(jpeg)
    await retainBulkScanOnly(forBusiness(s.b.businessId),id);expect(writes).toHaveLength(1)
  }finally{Object.assign(env,before);vi.unstubAllGlobals()}
})
it('shares learned preferences across all authorised roles while leaving batch state and roles separate',async()=>{
  const s=await setup(),other=await setup()
  await s.ok('POST','/agent/preferences',{action:'set',key:'response_style',value:'Keep answers brief and show brand totals.'},'333')
  for(const actor of ['111','222','333'])expect((await s.ok('GET','/agent/preferences',undefined,actor)).preferences.response_style).toContain('brand totals')
  expect((await other.ok('GET','/agent/preferences')).preferences.response_style).toBeUndefined()
  await s.ok('POST','/agent/preferences',{action:'append',key:'clarification_lessons',value:'When asking addons show quantities per addon.'},'222')
  expect((await s.ok('GET','/agent/preferences')).preferences.clarification_lessons).toContain('quantities')
  expect((await s.call('POST','/agent/preferences',{action:'set',key:'permissions',value:'OWNER'},'333')).statusCode).toBe(400)
  expect((await s.call('POST','/agent/preferences',{action:'set',key:'response_style',value:'Brief'},'999')).statusCode).toBe(403)
  await s.ok('POST','/agent/preferences',{action:'forget',key:'response_style'})
  expect((await s.ok('GET','/agent/preferences',undefined,'333')).preferences.response_style).toBeUndefined()
})
it('numbers stay global across pages and custom selection resolves the exact original list',async()=>{
  const s=await setup();await s.ok('POST','/agent/inbox/bulk/start',{})
  const ids=[];for(let i=0;i<21;i++)ids.push(await s.upload())
  const first=await s.ok('POST','/agent/inbox/review',{scope:'batch'})
  expect(first.entries).toHaveLength(20);expect(first.nextOffset).toBe(20)
  const second=await s.ok('POST','/agent/inbox/review',{scope:'batch',offset:20})
  expect(second.entries[0]).toMatchObject({number:21,id:ids[20]})
  expect((await s.ok('POST','/agent/inbox/select',{listId:first.listId,number:21})).receiptId).toBe(ids[20])
  expect((await s.ok('GET','/agent/inbox/context')).listId).toBe(first.listId)
  await s.ok('POST','/agent/inbox/end',{})
  expect((await s.ok('POST','/agent/inbox/next',{receiptId:ids[20],allowUnconfigured:true})).ended).toBe(true)
})
