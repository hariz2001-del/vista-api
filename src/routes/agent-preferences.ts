import type {FastifyInstance} from 'fastify'
import {z} from 'zod'
import {requireAgent} from '../auth.ts'
const guard={preHandler:requireAgent('VIEWER')}
const keys=z.enum(['response_style','terminology','report_defaults','receipt_preferences','workflow_preferences','clarification_lessons'])
const defaults={receipt_preferences:'Numbered receipt lists: 1. R-XXXXXX — Merchant · DD/MM/YYYY · RM 0.00. New receipt funding defaults to Stall funds. Bulk capture is silent; advance receipts only on request.'}
export async function agentPreferencesRoutes(app:FastifyInstance){
  async function read(db:any){
    const rows=await db.agentAction.findMany({where:{action:{in:['chopper.preference.set','chopper.preference.forgot']},entityId:{in:keys.options}},distinct:['entityId'],orderBy:{id:'desc'}})
    const preferences:Record<string,string>={...defaults},seen=new Set<string>()
    for(const row of rows){const key=row.entityId;if(!key||seen.has(key))continue;seen.add(key);if(row.action==='chopper.preference.set')preferences[key]=(row.detail as any).value;else delete preferences[key]}
    return preferences
  }
  app.get('/agent/preferences',guard,async r=>({scope:'shared business preferences — all authorised accounts',preferences:await read(r.db),note:'Preferences never grant permissions or replace live Vista facts. Batch/progress state stays actor-bound.'}))
  app.post('/agent/preferences',guard,async r=>{
    const body=z.object({action:z.enum(['set','append','forget']),key:keys,value:z.string().trim().min(1).max(1600).optional()}).refine(b=>b.action==='forget'||!!b.value,{message:'A preference value is required.'}).parse(r.body)
    await r.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM businesses WHERE id=${r.businessId} FOR UPDATE`
      const previous=await read(tx)
      const value=body.action==='append' ? [previous[body.key],body.value].filter(Boolean).join('\n').slice(-2400) : body.value
      await tx.agentAction.create({data:{businessId:r.businessId,agentUserId:r.agentUser!.id,action:body.action==='forget'?'chopper.preference.forgot':'chopper.preference.set',entityType:'shared-preference',entityId:body.key,detail:{value:value??''}}})
    })
    return {saved:true,scope:'all authorised accounts',preferences:await read(r.db)}
  })
}
