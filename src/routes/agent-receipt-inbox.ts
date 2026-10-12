import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAgent } from '../auth.ts'
import { DomainError, notFound, conflict } from '../errors.ts'
import { inboxSettings } from '../receipt-inbox.ts'
import { readingHash } from '../receipt-form.ts'
import { driveConfigured, findDriveReceiptEvidence } from '../integrations/drive.ts'
import { env } from '../env.ts'
import { randomUUID } from 'node:crypto'

const guard = { preHandler: requireAgent('BOOKKEEPER') }, ID = z.string().uuid()
const json = (value: any) => JSON.parse(JSON.stringify(value))
const reviewQuery=z.object({order:z.enum(['flags','others','oldest']).default('oldest'),offset:z.number().int().min(0).max(10000).default(0),sequential:z.boolean().default(false),scope:z.enum(['all','batch']).default('all'),bulkId:ID.optional()})
export async function agentReceiptInboxRoutes(app: FastifyInstance) {
  async function invoke(r: FastifyRequest, method: 'GET' | 'POST', path: string, payload?: object) {
    const reply = await app.inject({ method, url: path, payload, headers: { authorization: r.headers.authorization!, 'x-telegram-user': r.agentUser!.telegramUserId } })
    const body = reply.json()
    if (reply.statusCode >= 400) throw new DomainError(body.error, reply.statusCode, body.message)
    return body
  }
  const audit = (r: FastifyRequest, action: string, entityId: string, detail: any,actorId=r.agentUser!.id) => r.db.agentAction.create({ data: { businessId: r.businessId, agentUserId: actorId, action, entityType: 'receipt-inbox', entityId, detail: json(detail) } })
  app.get('/agent/inbox/settings', guard, r => inboxSettings(r.db, r.agentUser!.id))
  app.get('/agent/inbox/context',guard,async r=>{
    const selected=await r.db.agentAction.findFirst({where:{agentUserId:r.agentUser!.id,action:'receipt.inbox.selected'},orderBy:{id:'desc'}})
    const listId=(selected?.detail as any)?.listId
    const list=await r.db.agentAction.findFirst({where:{agentUserId:r.agentUser!.id,action:'receipt.inbox.list',...(listId?{id:BigInt(listId)}:{})},orderBy:{id:'desc'}})
    return {listId:list?.id.toString(),...(list?.detail as object),selectedReceiptId:selected?.entityId}
  })
  app.patch('/agent/inbox/settings', guard, async r => {
    const body = z.object({ autoStash: z.boolean() }).parse(r.body)
    const previous=await inboxSettings(r.db,r.agentUser!.id)
    await audit(r, 'receipt.inbox.mode', r.agentUser!.id, {...body,bulk:false,bulkId:previous.bulkId})
    return inboxSettings(r.db, r.agentUser!.id)
  })
  app.post('/agent/inbox/bulk/start',guard,async r=>{
    const previous=await inboxSettings(r.db,r.agentUser!.id)
    if(previous.bulk)return previous
    const bulkId=randomUUID()
    await audit(r,'receipt.inbox.mode',r.agentUser!.id,{autoStash:true,bulk:true,bulkId})
    return inboxSettings(r.db,r.agentUser!.id)
  })
  app.post('/agent/inbox/bulk/end',guard,async r=>{
    const previous=await inboxSettings(r.db,r.agentUser!.id)
    await audit(r,'receipt.inbox.mode',r.agentUser!.id,{autoStash:false,bulk:false,bulkId:previous.bulkId})
    if(previous.bulkId && !await r.db.agentAction.findFirst({where:{agentUserId:r.agentUser!.id,entityId:previous.bulkId,action:'receipt.bulk.closed'}}))await audit(r,'receipt.bulk.closed',previous.bulkId,{bulkId:previous.bulkId,chatId:r.agentUser!.telegramUserId})
    return inboxSettings(r.db,r.agentUser!.id)
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/checks', guard, async r => {
    const id = ID.parse(r.params.id), receipt = await r.db.receiptDocument.findUnique({ where: { id } })
    if (!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
    const [duplicates, matches] = await Promise.all([invoke(r,'GET',`/agent/receipts/${id}/duplicates`),invoke(r,'GET',`/agent/receipts/${id}/matches`)])
    let drive: any = { checked: false, candidates: [], note: 'Drive unavailable or no invoice to search.' }
    if (driveConfigured() && env.DRIVE_BUSINESS_ID === r.businessId && receipt.receiptNo) {
      try { drive = { checked: true, candidates: await findDriveReceiptEvidence(receipt.receiptNo, [receipt.driveFileId, receipt.scanDriveFileId].filter((s): s is string => !!s),receipt.id), note: 'Bounded invoice/file metadata search inside Finances; not proof of duplicate spending.' } }
      catch { drive = { checked: false, candidates: [], note: 'Drive check failed; review/retry before categorising.' } }
    }
    const checks = { readingHash: readingHash(receipt), checkedAt: new Date().toISOString(), duplicates: duplicates.candidates, matches: matches.matches.filter((m: any) => m.receiptDocumentId !== receipt.id), drive }
    await r.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id=${id} AND business_id=${r.businessId} FOR UPDATE`
      const fresh = await tx.receiptDocument.findUniqueOrThrow({ where: { id } })
      if (readingHash(fresh) !== checks.readingHash) throw conflict('agent:FORM_STALE')
      await tx.receiptDocument.update({ where: { id }, data: { extracted: json({ ...(fresh.extracted as any), _checks: checks }) } })
    })
    return checks
  })
  async function buildReview(r:FastifyRequest,q:z.infer<typeof reviewQuery>,actorId=r.agentUser!.id){
    const settings=await inboxSettings(r.db,actorId), bulkId=q.scope==='batch' ? q.bulkId??settings.bulkId : null
    const received=bulkId ? await r.db.agentAction.findMany({where:{agentUserId:actorId,action:'receipt.bulk.received',detail:{path:['bulkId'],equals:bulkId}},orderBy:{id:'asc'},take:10001}) : []
    const batchIds=[...new Set(received.map(e=>e.entityId).filter((id):id is string=>!!id))]
    const receipts = await r.db.receiptDocument.findMany({ where: q.scope==='batch' ? {id:{in:batchIds}} : { status: { in: ['UPLOADED','PENDING_REVIEW','SKIPPED'] } }, include: { job: true, expenses: { select: { id: true, amountSen: true } } }, orderBy: { createdAt: 'asc' }, take: 10001 })
    if(bulkId)receipts.sort((a,b)=>batchIds.indexOf(a.id)-batchIds.indexOf(b.id))
    const entries = receipts.flatMap(receipt => {
      const x = receipt.extracted as any, workflow = x?._lineWorkflow
      if (q.scope!=='batch' && (x?.duplicateOf || workflow && !workflow.decisions.some((d: any) => d.state === 'pending'))) return []
      const checks = x?._checks, flags = [...receipt.reviewFlags]
      if (checks?.duplicates?.length) flags.push('Same paper / possible duplicate — check split allocations')
      if (checks?.matches?.length) flags.push('Existing Vista transactions — review linking')
      if (checks?.drive?.candidates?.length) flags.push('Possible matching Drive evidence')
      if (checks?.drive && !checks.drive.checked) flags.push('Drive check incomplete')
      if (!checks || checks.readingHash !== readingHash(receipt)) flags.push('Cross-check pending')
      if (x?._inbox?.deferred) flags.push('Revisit later')
      const ready = (!!x?.lines?.length || x?.document_type === 'bank_screenshot' && receipt.totalSen !== null) && !!receipt.driveFileId && (receipt.mimeType === 'application/pdf' || !!receipt.scanDriveFileId) && (!x?._inbox?.scanOnly || !!x._inbox.originalRetired)
      if (x?.document_type === 'bank_screenshot' && (x.transaction_direction !== 'outgoing' || !x.purpose)) flags.push('Bank transaction type / purpose needs review')
      if (!ready) flags.push(receipt.job?.status === 'FAILED' ? 'Processing failed — retry needed' : 'Reading / scan / Drive processing')
      return [{ id: receipt.id, ref: `R-${receipt.id.slice(0,6).toUpperCase()}`, vendor: receipt.vendor, date: receipt.receiptDate?.toISOString().slice(0,10), totalSen: receipt.totalSen, flags, ready, deferred: Boolean(x?._inbox?.deferred), failed:receipt.job?.status==='FAILED',documentType: x?.document_type ?? 'receipt', allocatedSen: receipt.expenses.reduce((s,e) => s+e.amountSen,0) }]
    })
    const events=q.scope==='batch' ? [] : await r.db.agentAction.findMany({where:{agentUserId:actorId,action:{in:['receipt.inbox.duplicate','receipt.inbox.duplicate.reviewed']}},orderBy:{id:'desc'},take:500})
    const seen=new Set<string>()
    for(const event of events) {
      if(!event.entityId || seen.has(event.entityId)) continue
      seen.add(event.entityId)
      if(event.action==='receipt.inbox.duplicate.reviewed') continue
      const existing=entries.find(e=>e.id===event.entityId)
      if(existing){existing.flags.push('Same photo resent — review prior allocations');continue}
      const receipt=await r.db.receiptDocument.findUnique({where:{id:event.entityId},include:{expenses:{select:{amountSen:true}}}})
      if(receipt) entries.push({id:receipt.id,ref:`R-${receipt.id.slice(0,6).toUpperCase()}`,vendor:receipt.vendor,date:receipt.receiptDate?.toISOString().slice(0,10),totalSen:receipt.totalSen,flags:['Same photo resent — already recorded evidence; check split allocations'],ready:Boolean(receipt.driveFileId && (receipt.mimeType==='application/pdf'||receipt.scanDriveFileId)),deferred:false,failed:false,documentType:(receipt.extracted as any)?.document_type??'receipt',allocatedSen:receipt.expenses.reduce((s,e)=>s+e.amountSen,0)})
    }
    const sorted = entries.toSorted((a,b) => q.order === 'flags' ? Number(!!b.flags.length)-Number(!!a.flags.length) : q.order === 'others' ? Number(!!a.flags.length)-Number(!!b.flags.length) : 0)
    const page = sorted.slice(q.offset, q.offset+20)
    const action = await audit(r,'receipt.inbox.list',actorId,{ ids: sorted.map(e => e.id), order:q.order, sequential:q.sequential, offset:q.offset,bulkId,listScope:q.scope },actorId)
    return { listId: action.id.toString(), entries: page.map((e,i) => ({ ...e, number:q.offset+i+1 })), total: entries.length, nextOffset: sorted.length > q.offset+20 ? q.offset+20 : null,previousOffset:q.offset>0?Math.max(0,q.offset-20):null,pendingCount:entries.filter(e=>!e.ready && !e.failed).length,failedCount:entries.filter(e=>e.failed).length,truncated:receipts.length>10000,listScope:q.scope, ...settings }
  }
  app.post('/agent/inbox/review',guard,r=>buildReview(r,reviewQuery.parse(r.body??{})))
  app.post('/agent/inbox/bulk/ready',guard,async r=>{
    const body=z.object({bulkId:ID.optional(),receiptId:ID.optional()}).parse(r.body??{})
    const receipt=body.receiptId ? await r.db.receiptDocument.findUnique({where:{id:body.receiptId}}):null
    const bulkId=body.bulkId ?? (receipt?.extracted as any)?._inbox?.bulkId ?? (await inboxSettings(r.db,r.agentUser!.id)).bulkId
    if(!bulkId)return {delivery:null}
    const closed=await r.db.agentAction.findFirst({where:{action:'receipt.bulk.closed',entityId:bulkId,...(r.agentUser!.role==='OWNER'?{}:{agentUserId:r.agentUser!.id})},orderBy:{id:'desc'}})
    if(!closed?.agentUserId)return {delivery:null}
    const received=await r.db.agentAction.findMany({where:{agentUserId:closed.agentUserId,action:'receipt.bulk.received',detail:{path:['bulkId'],equals:bulkId}},select:{entityId:true}})
    const receipts=await r.db.receiptDocument.findMany({where:{id:{in:received.flatMap(e=>e.entityId?[e.entityId]:[])}},include:{job:true}})
    const pending=receipts.filter(receipt=>{const x=receipt.extracted as any;return receipt.job?.status!=='FAILED' && (!(x?.lines?.length||x?.document_type==='bank_screenshot') || !receipt.scanDriveFileId && receipt.mimeType!=='application/pdf' || !receipt.driveFileId || x?._inbox?.scanOnly && !x._inbox.originalRetired)})
    if(pending.length)return {delivery:null,pending:pending.length}
    const leaseToken=randomUUID()
    const claimed=await r.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM agent_actions WHERE id=${closed.id} AND business_id=${r.businessId} FOR UPDATE`
      const current=await tx.agentAction.findUniqueOrThrow({where:{id:closed.id}}),detail=current.detail as any
      if(detail.notified || detail.deliveryLeaseUntil>Date.now())return false
      await tx.agentAction.update({where:{id:closed.id},data:{detail:json({...detail,deliveryLeaseToken:leaseToken,deliveryLeaseUntil:Date.now()+120000})}})
      return true
    })
    if(!claimed)return {delivery:null}
    const result=await buildReview(r,reviewQuery.parse({scope:'batch',bulkId,sequential:true}),closed.agentUserId)
    return {delivery:{id:closed.id.toString(),leaseToken,chatId:(closed.detail as any).chatId,result}}
  })
  app.post('/agent/inbox/bulk/delivered',guard,async r=>{
    const body=z.object({id:z.string().regex(/^\d{1,19}$/),leaseToken:ID,messageId:z.number().int().positive()}).parse(r.body)
    await r.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM agent_actions WHERE id=${BigInt(body.id)} AND business_id=${r.businessId} FOR UPDATE`
      const current=await tx.agentAction.findFirst({where:{id:BigInt(body.id),action:'receipt.bulk.closed',...(r.agentUser!.role==='OWNER'?{}:{agentUserId:r.agentUser!.id})}})
      const detail=current?.detail as any
      if(!current || detail.deliveryLeaseToken!==body.leaseToken)throw conflict('agent:LEASE_STALE')
      await tx.agentAction.update({where:{id:current.id},data:{detail:json({...detail,notified:true,messageId:body.messageId})}})
    })
    return {saved:true}
  })
  app.post('/agent/inbox/select', guard, async r => {
    const q = z.object({ listId:z.string().regex(/^\d{1,19}$/).optional(), number:z.number().int().min(1).max(10000) }).parse(r.body)
    const list = await r.db.agentAction.findFirst({ where:{ agentUserId:r.agentUser!.id,action:'receipt.inbox.list',...(q.listId ? {id:BigInt(q.listId)} : {}) },orderBy:{id:'desc'} })
    const rid = (list?.detail as any)?.ids[q.number-1]
    if (!rid || !list || list.createdAt.getTime() < Date.now()-24*60*60000) throw notFound('agent:INBOX_LIST_EXPIRED')
    if (!q.listId) {
      const selected=await r.db.agentAction.findFirst({where:{agentUserId:r.agentUser!.id,action:'receipt.inbox.selected'},orderBy:{id:'desc'}})
      if (selected && selected.id>list.id || list.createdAt.getTime()<Date.now()-30*60000) throw notFound('agent:INBOX_LIST_EXPIRED')
    }
    await audit(r,'receipt.inbox.selected',rid,{listId:list.id.toString(),number:q.number})
    return { receiptId:rid, form:await invoke(r,'GET',`/agent/receipts/${rid}/form`) }
  })
  app.post('/agent/inbox/next', guard, async r => {
    const body=z.object({receiptId:ID,allowUnconfigured:z.boolean().default(false)}).parse(r.body),currentId=body.receiptId
    const selected=await r.db.agentAction.findFirst({where:{agentUserId:r.agentUser!.id,action:'receipt.inbox.selected'},orderBy:{id:'desc'}})
    if (!selected || selected.entityId!==currentId || selected.createdAt.getTime()<Date.now()-24*60*60000) return {next:null}
    const current=await invoke(r,'GET',`/agent/receipts/${currentId}/form`)
    if (!current.readOnly && !body.allowUnconfigured) return {next:null}
    const list=await r.db.agentAction.findFirst({where:{id:BigInt((selected.detail as any).listId),agentUserId:r.agentUser!.id,action:'receipt.inbox.list'}})
    if (!list) return {next:null}
    const ended=await r.db.agentAction.findFirst({where:{agentUserId:r.agentUser!.id,action:'receipt.inbox.end'},orderBy:{id:'desc'}})
    if(ended && ended.id>selected.id)return {next:null,ended:true}
    const ids=(list!.detail as any).ids as string[], after=ids.indexOf(selected.entityId!)
    for(let i=after+1;i<ids.length;i++) {
      const receipt=await r.db.receiptDocument.findUnique({where:{id:ids[i]}}), x=receipt?.extracted as any
      if (!receipt || ['POSTED','LINKED','REJECTED'].includes(receipt.status) || x?._inbox?.deferred || x?._lineWorkflow && !x._lineWorkflow.decisions.some((d:any)=>d.state==='pending')) continue
      await audit(r,'receipt.inbox.selected',receipt.id,{listId:list!.id.toString(),number:i+1})
      return {next:{receiptId:receipt.id,form:await invoke(r,'GET',`/agent/receipts/${receipt.id}/form`)}}
    }
    return {next:null,endOfPage:true}
  })
  app.post('/agent/inbox/end',guard,async r=>{await audit(r,'receipt.inbox.end',r.agentUser!.id,{});return {ended:true}})
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/defer', guard, async r => {
    const id=ID.parse(r.params.id)
    await r.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id=${id} AND business_id=${r.businessId} FOR UPDATE`
      const receipt=await tx.receiptDocument.findUnique({where:{id}})
      if(!receipt) throw notFound('agent:RECEIPT_NOT_FOUND')
      await tx.receiptDocument.update({where:{id},data:{extracted:json({...receipt.extracted as any,_inbox:{...(receipt.extracted as any)?._inbox,deferred:true}})}})
    })
    await audit(r,'receipt.inbox.deferred',id,{})
    return { saved:true, message:'Kept and flagged Revisit later. No expense created.' }
  })
  app.post<{ Params: { id: string } }>('/agent/receipts/:id/duplicate-reviewed', guard, async r => {
    const id=ID.parse(r.params.id)
    if(!await r.db.receiptDocument.findUnique({where:{id}})) throw notFound('agent:RECEIPT_NOT_FOUND')
    await audit(r,'receipt.inbox.duplicate.reviewed',id,{})
    return {saved:true,message:'Duplicate upload acknowledged; original evidence and accounting unchanged.'}
  })
}
