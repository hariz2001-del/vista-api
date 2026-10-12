import {it,expect,vi} from 'vitest'
import {env} from '../src/env.ts'
import {trashDuplicateReceiptFile} from '../src/integrations/drive.ts'
it('trashes only tagged duplicate evidence inside Finances; retry is recoverable/idempotent',async()=>{
  const keys=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','DRIVE_FINANCES_FOLDER_ID'] as const
  const before=Object.fromEntries(keys.map(k=>[k,env[k]]));Object.assign(env,{GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test',GOOGLE_REFRESH_TOKEN:'test',DRIVE_FINANCES_FOLDER_ID:'finances-root'})
  let trashed=false;const writes:any[]=[]
  vi.stubGlobal('fetch',async(url:string,init:any={})=>{
    if(url.includes('oauth2'))return new Response(JSON.stringify({access_token:'test-only',expires_in:3600}))
    const id=url.split('/files/')[1]?.split('?')[0]
    if(init.method==='PATCH'){writes.push({id,body:JSON.parse(init.body)});trashed=true}
    return new Response(JSON.stringify(id==='finances-root'?{id,mimeType:'application/vnd.google-apps.folder',parents:[]}:{id,name:'duplicate scan',mimeType:'image/jpeg',parents:['finances-root'],appProperties:{vistaReceiptId:'source'},trashed}))
  })
  try{
    expect((await trashDuplicateReceiptFile('source-file','source')).trashed).toBe(true)
    await trashDuplicateReceiptFile('source-file','source')
    expect(writes).toEqual([{id:'source-file',body:{trashed:true}}])
    trashed=false;await expect(trashDuplicateReceiptFile('canonical-file','other-receipt')).rejects.toThrow('tagged evidence')
    expect(writes).toHaveLength(1)
  }finally{Object.assign(env,before);vi.unstubAllGlobals()}
})
