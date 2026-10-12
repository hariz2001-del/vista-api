import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { requireAgent } from '../auth.ts'
import { conflict, notFound } from '../errors.ts'
import { expenseBody, previewExpense } from './rms.ts'
import { driveFile, driveConfigured, withinFinances, trashDuplicateReceiptFile } from '../integrations/drive.ts'
import { env } from '../env.ts'
const ID=z.string().uuid(), guard={preHandler:requireAgent('OWNER')}
const json=(v:any)=>JSON.parse(JSON.stringify(v))
const fingerprint=(v:any)=>createHash('sha256').update(JSON.stringify(v,(_,value)=>value && typeof value==='object' && !Array.isArray(value)?Object.fromEntries(Object.entries(value).toSorted(([a],[b])=>a.localeCompare(b))):value)).digest('hex')
/** Capture the existing RMS correction handler, not a second accounting engine. */
export function collectAgentMaintenance(app:FastifyInstance){
  let editHandler:RouteOptions['handler']|undefined
  app.addHook('onRoute',route=>{if(route.url==='/rms/expenses/:id' && route.method==='PUT')editHandler=route.handler})
  const audit=(r:FastifyRequest,action:string,id:string,detail:any)=>r.db.agentAction.create({data:{businessId:r.businessId,agentUserId:r.agentUser!.id,action,entityType:'receipt-maintenance',entityId:id,detail:json(detail)}})
  async function duplicate(r:FastifyRequest,id:string){
    const source=await r.db.receiptDocument.findUnique({where:{id},include:{expenses:true,job:true}})
    if(!source)throw notFound('agent:RECEIPT_NOT_FOUND')
    const canonicalId=(source.extracted as any)?.duplicateOf
    if(!canonicalId || canonicalId===id || source.expenses.length || source.job?.status==='RUNNING')throw conflict('agent:NOT_SAFE_DUPLICATE','First explicitly reuse the canonical paper; linked/booked receipts and running workers cannot be deleted.')
    const canonical=await r.db.receiptDocument.findUnique({where:{id:canonicalId},include:{image:true}})
    if(!canonical || ['REJECTED'].includes(canonical.status) || !(canonical.driveFileId||canonical.image) || (canonical.extracted as any)?._deletedEvidence)throw conflict('agent:CANONICAL_EVIDENCE_REQUIRED')
    if(canonical.driveFileId){
      if(!driveConfigured()||env.DRIVE_BUSINESS_ID!==r.businessId)throw conflict('agent:DRIVE_NOT_BOUND')
      await withinFinances(canonical.driveFileId)
    }
    const ids=[...new Set([source.driveFileId,source.scanDriveFileId,(source.extracted as any)?._lineWorkflow?.annotation?.id].filter((v):v is string=>typeof v==='string'))]
    for(const fileId of ids) {
      if(await r.db.receiptDocument.findFirst({where:{id:{not:id},OR:[{driveFileId:fileId},{scanDriveFileId:fileId},{extracted:{path:['_lineWorkflow','annotation','id'],equals:fileId}}]}}))throw conflict('agent:EVIDENCE_SHARED')
    }
    return {source,canonical,ids}
  }
  return ()=>{
    if(!editHandler)throw new Error('Existing RMS expense correction handler not found.')
    app.get<{Params:{id:string}}>('/agent/expenses/:id/edit',guard,async r=>{
      const expense=await r.db.expense.findUnique({where:{id:ID.parse(r.params.id)},include:{items:{orderBy:{sortOrder:'asc'}}}})
      if(!expense)throw notFound('rms:EXPENSE_NOT_FOUND')
      return {expense:json(expense),fields:Object.keys(expenseBody.shape),note:'Use preview with changed fields; native Confirm edit is required. Receipt original remains unchanged.'}
    })
    app.post<{Params:{id:string}}>('/agent/expenses/:id/edit/preview',guard,async r=>{
      const id=ID.parse(r.params.id),changes=expenseBody.partial().strict().parse(r.body)
      const expense=await r.db.expense.findUnique({where:{id},include:{items:{orderBy:{sortOrder:'asc'}}}})
      if(!expense)throw notFound('rms:EXPENSE_NOT_FOUND')
      const entry=expenseBody.parse({...expense,businessDate:expense.businessDate.toISOString().slice(0,10),items:expense.items.map(({name,quantityMilli,unitPriceSen,unit})=>({name,quantityMilli,unitPriceSen,unit})),...changes})
      const preview=await previewExpense(r.db,r.businessId,entry)
      const action=await audit(r,'expense.edit.preview',id,{entry,before:fingerprint(expense)})
      return {confirmationId:action.id.toString(),before:json(expense),after:entry,allocation:preview,note:'Not saved. Existing cash-book reversals/replacement use RMS rules after confirmation.'}
    })
    app.post<{Params:{id:string}}>('/agent/expenses/:id/edit/confirm',guard,async(r,reply)=>{
      const id=ID.parse(r.params.id),body=z.object({confirmationId:z.string().regex(/^\d{1,19}$/)}).parse(r.body)
      return r.db.$transaction(async tx=>{
        const snapshot=await tx.expense.findUnique({where:{id}})
        if(!snapshot)throw notFound('rms:EXPENSE_NOT_FOUND')
        if(snapshot.receiptDocumentId)await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id=${snapshot.receiptDocumentId} AND business_id=${r.businessId} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM expenses WHERE id=${id} AND business_id=${r.businessId} FOR UPDATE`
        const p=await tx.agentAction.findFirst({where:{id:BigInt(body.confirmationId),agentUserId:r.agentUser!.id,entityId:id,action:'expense.edit.preview'}})
        if(!p)throw notFound('agent:PREVIEW_NOT_FOUND')
        const expense=await tx.expense.findUniqueOrThrow({where:{id},include:{items:{orderBy:{sortOrder:'asc'}}}})
        if(fingerprint(expense)!==(p.detail as any).before)throw conflict('agent:PREVIEW_STALE')
        if(await tx.agentAction.findFirst({where:{action:'expense.edited',agentUserId:r.agentUser!.id,entityId:id,detail:{path:['confirmationId'],equals:body.confirmationId}}}))throw conflict('agent:ALREADY_CONFIRMED')
        const owner=await tx.user.findFirstOrThrow({where:{role:'OWNER',isActive:true},orderBy:{createdAt:'asc'}})
        const db=Object.assign(Object.create(tx),{$transaction:(fn:any)=>fn(tx)})
        const request={...r,db,businessId:r.businessId,params:{id},body:(p.detail as any).entry,user:{id:owner.id}} as FastifyRequest
        const result=await editHandler!.call(app,request,reply)
        if(expense.receiptDocumentId){
          const receipt=await tx.receiptDocument.findUniqueOrThrow({where:{id:expense.receiptDocumentId}}),x=receipt.extracted as any,entry=(p.detail as any).entry
          if(x?._lineWorkflow){
            for(const d of x._lineWorkflow.decisions)if(d.expenseId===id){d.brand=entry.brandId??'SHARED';d.category=entry.category}
            x._lineWorkflow.version++;delete x._entryForms
            if(entry.amountSen!==expense.amountSen || fingerprint(entry.items)!==fingerprint(expense.items.map(({name,quantityMilli,unitPriceSen,unit})=>({name,quantityMilli,unitPriceSen,unit}))))x._allocationCorrection=true
            await tx.receiptDocument.update({where:{id:receipt.id},data:{extracted:json(x)}})
            await tx.receiptJob.upsert({where:{receiptId:receipt.id},create:{businessId:r.businessId,receiptId:receipt.id},update:{status:'PENDING',attempts:0,leaseUntil:null,error:null}})
          }
        }
        await tx.agentAction.create({data:{businessId:r.businessId,agentUserId:r.agentUser!.id,action:'expense.edited',entityType:'expense',entityId:id,detail:json({confirmationId:body.confirmationId,before:expense,after:(p.detail as any).entry})}})
        return {saved:true,result,note:'Expense corrected using RMS rules; original receipt preserved.'}
      })
    })
    app.post<{Params:{id:string}}>('/agent/receipts/:id/cleanup/preview',guard,async r=>{
      const id=ID.parse(r.params.id),{source,canonical,ids}=await duplicate(r,id)
      const files=[]
      if(ids.length){
        if(!driveConfigured()||env.DRIVE_BUSINESS_ID!==r.businessId)throw conflict('agent:DRIVE_NOT_BOUND')
        for(const fileId of ids){const f=await driveFile(fileId);if(!f.trashed)await withinFinances(fileId);if(f.appProperties?.vistaReceiptId!==id)throw conflict('agent:EVIDENCE_NOT_TAGGED');files.push({id:f.id,name:f.name,trashed:f.trashed})}
      }
      const p=await audit(r,'receipt.cleanup.preview',id,{canonicalId:canonical.id,files:ids,sourceHash:fingerprint([source.sha256,source.driveFileId,source.scanDriveFileId])})
      return {confirmationId:p.id.toString(),receiptId:id,canonicalReceiptId:canonical.id,files,note:'Trash only duplicate Drive photos and clear duplicate Vista image cache. Keep metadata tombstone, canonical evidence, all expenses and audit. Drive Trash is recoverable.'}
    })
    app.post<{Params:{id:string}}>('/agent/receipts/:id/cleanup/confirm',guard,async r=>{
      const id=ID.parse(r.params.id),body=z.object({confirmationId:z.string().regex(/^\d{1,19}$/)}).parse(r.body)
      const p=await r.db.agentAction.findFirst({where:{id:BigInt(body.confirmationId),entityId:id,agentUserId:r.agentUser!.id,action:'receipt.cleanup.preview'}})
      if(!p)throw notFound('agent:PREVIEW_NOT_FOUND')
      return r.db.$transaction(async tx=>{
        for(const lockId of [id,(p.detail as any).canonicalId].toSorted())await tx.$queryRaw`SELECT id FROM receipt_documents WHERE id=${lockId} AND business_id=${r.businessId} FOR UPDATE`
        const {source,canonical,ids}=await duplicate({...r,db:tx} as FastifyRequest,id),saved=p.detail as any
        if(saved.canonicalId!==canonical.id || saved.sourceHash!==fingerprint([source.sha256,source.driveFileId,source.scanDriveFileId]) || fingerprint(ids)!==fingerprint(saved.files))throw conflict('agent:PREVIEW_STALE')
        // Hold the evidence locks while trashing: linking cannot race cleanup.
        // Partial Google failure is recoverable and never repeats a ledger write.
        for(const fileId of ids)await trashDuplicateReceiptFile(fileId,id)
        await tx.receiptImage.deleteMany({where:{receiptId:id}})
        await tx.receiptDocument.update({where:{id},data:{status:'REJECTED',extracted:json({...source.extracted as any,_deletedEvidence:{at:new Date().toISOString(),canonicalId:canonical.id,files:ids,confirmationId:body.confirmationId}})}})
        await tx.receiptJob.updateMany({where:{receiptId:id},data:{status:'DONE',leaseUntil:null}})
        await tx.agentAction.create({data:{businessId:r.businessId,agentUserId:r.agentUser!.id,action:'receipt.duplicate.photos.trashed',entityType:'receipt',entityId:id,detail:json(saved)}})
        return {removedPhotos:ids.length,canonicalReceiptId:canonical.id,recoverable:'Drive Trash; canonical original unchanged',vista:'Duplicate image cache removed, metadata/audit retained.'}
      },{timeout:120000})
    })
  }
}
