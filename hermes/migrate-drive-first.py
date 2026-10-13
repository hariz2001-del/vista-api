"""Adopt existing evidence into Chopper without re-posting any finances.

Uses the exact database/Drive backup manifest; scans remain real source pixels.
Existing valid scans are verified and retained, not cropped a second time.
"""
import sys
sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
import json, time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import vista_mcp as m
import chopper_receipts as cr

def adopt(row,business):
    rid=row['id'];actor=str((row.get('uploadedBy') or {}).get('telegramUserId') or '304348232')
    with cr.db() as c:
        if c.execute('SELECT id FROM receipts WHERE id=?',(rid,)).fetchone():return cr.get(rid)
    d=cr.service(m);x=row.get('extracted') or {};scan_id=row.get('scanDriveFileId');source_id=row.get('driveFileId')
    raw_lines=x.get('lines') or []
    lines=[]
    for l in raw_lines:
        q=l.get('quantityMilli') or round(float(l.get('qty') or 1)*1000)
        unit=l.get('unitPriceSen') if l.get('unitPriceSen') is not None else round(float(l.get('unit_price_rm') or 0)*100)
        amount=l.get('amountSen') if l.get('amountSen') is not None else round(float(l.get('amount_rm') or q*unit/100000)*100)
        lines.append({'name':str(l.get('name') or 'Needs review'),'quantityMilli':q,'unitPriceSen':unit,'amountSen':amount})
    total=row.get('totalSen');diff=(total-sum(l['amountSen'] for l in lines)) if total is not None else 0
    if diff:lines.append({'name':'Printed total adjustment — review rounding/tax','quantityMilli':1000,'unitPriceSen':diff,'amountSen':diff})
    reading={'vendor':row.get('vendor'),'date':(row.get('receiptDate') or '')[:10] or None,'receiptNo':row.get('receiptNo'),'totalSen':total,'lines':lines,'flags':row.get('reviewFlags',[])}
    if not lines:reading['flags'].append('Missing line reading')
    # Old original-relative corners are NOT reused on an already-flattened scan.
    data={'chat':actor,'message':str(row.get('telegramMessageId') or ''),'mime':row['mimeType'],'batch':'legacy-import','reading':reading,'choices':{},'decisions':['pending']*len(lines),'sourceFile':source_id,'legacy':True,'oldScan':scan_id,'notified':True}
    # Retain previously chosen fields, never automatically replay old postings.
    expenses=row.get('expenses') or []
    if len(expenses)==1:
        old=expenses[0]
        data['choices']={k:old.get(k) for k in ('category','paidBy','brandId','paymentMethod','foodSplitPct')}
        data['restoredChoices']=True
    state='UNCONFIGURED'
    if not scan_id:
        data['sourcePath']=str(cr.ROOT/(rid+'.source'));data['reading']=None;state='PROCESSING'
    else:
        file=d.scoped(scan_id);bytes=d.request('/files/'+file['id']+'?alt=media',raw=True)
        path=cr.ROOT/(rid+'.scan.jpg');cr.ROOT.mkdir(parents=True,exist_ok=True);path.write_bytes(bytes)
        data.update(fileId=scan_id,scanHash=cr.sha(bytes),scanPath=str(path),scanVerified=False)
        # Keep the only scan now, but original retirement waits for a real visual check.
        cr.move(d,scan_id,cr.layout(d)['Unconfigured'],'CHR-'+rid+'__'+cr.safe_name(reading['vendor'])+'.jpg')
        state='VERIFYING'
    with cr.db() as c:c.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?,0,?,?)',(rid,actor,business,'legacy:'+rid,row['sha256'],state,cr.json_text(data),time.time()))
    return cr.get(rid)

def verify(r):
    v=r['data'];d=cr.service(m)
    check=cr.hermes_read(v['scanPath'],'Inspect this existing receipt scan. Return ONLY JSON {"complete":boolean,"readable":boolean,"totalSen":integer|null,"flags":[string]}. Check all financial text and receipt edges remain readable. Do not invent hidden text. No tools or financial actions.')
    if check.get('complete') and check.get('readable') and check.get('totalSen')==v['reading']['totalSen']:
        v['scanVerified']=True;r['state']='UNCONFIGURED';r=cr.save(r);cr.sync_register(m)
        if v.get('sourceFile') and v['sourceFile']!=v['fileId']:
            d.scoped(v['sourceFile'],allow_trash=True);d.request('/files/'+v['sourceFile'],'PATCH',{'trashed':True})
    else:
        v['reading']['flags']=list(set(v['reading'].get('flags',[])+['Existing scan needs review; original retained']))
        r['state']='UNCONFIGURED';r=cr.save(r)
    return r

if __name__=='__main__':
    snapshot=json.loads(Path(sys.argv[1]).read_text());context=cr.authorise(m,'304348232')
    if snapshot['businessId']!=context['businessId']:raise SystemExit('Migration business mismatch')
    for row in snapshot['receipts']:
        r=adopt(row,snapshot['businessId']);print(json.dumps({'adopted':r['id'],'state':r['state']}),flush=True)
    cr.sync_register(m)
    if '--retain-review-originals' in sys.argv:
        d=cr.service(m);folders=cr.layout(d)
        for r in cr.pending('304348232'):
            v=r['data']
            if v.get('scanVerified') or not v.get('sourceFile'):continue
            source=d.scoped(v['sourceFile'],allow_trash=True)
            if source.get('trashed'):d.request('/files/'+source['id'],'PATCH',{'trashed':False})
            cr.move(d,source['id'],folders['Processing'],'CHR-'+r['id']+'__original-review.jpg')
        print('Uncertain originals retained in Processing, not old dated folders.',flush=True)
    if '--verify' in sys.argv:
        from concurrent.futures import ThreadPoolExecutor
        rows=[r for r in cr.pending('304348232') if r['state']=='VERIFYING']
        def bounded(r):
            try:return verify(r)
            except Exception as e:
                latest=cr.get(r['id']);latest['data']['reading']['flags'].append('Visual verification pending: '+type(e).__name__);latest['state']='UNCONFIGURED';return cr.save(latest)
        with ThreadPoolExecutor(max_workers=2) as pool:
            for r in pool.map(bounded,rows):print(json.dumps({'verified':r['id'],'scanVerified':r['data'].get('scanVerified',False)}),flush=True)
        cr.sync_register(m)
