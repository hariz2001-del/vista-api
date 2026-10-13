"""Profile-local queue consumer, two bounded Hermes Luna readers; no posting."""
import sys
sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
import asyncio, concurrent.futures, time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from types import SimpleNamespace
import vista_mcp as m
import chopper_receipts as cr

def work(rid):
    try:
        r=cr.get(rid)
        if r['data'].get('retirementPending'):return cr.retire_source(m,r)
        if r['state']=='FILING':return cr.finish_filing(m,r)
        if r['state']=='VERIFYING':
            import importlib.util
            from pathlib import Path
            spec=importlib.util.spec_from_file_location('migration_verify',Path(__file__).with_name('migrate-drive-first.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            return module.verify(r)
        return cr.process(m,rid)
    except Exception as e:
        r=cr.get(rid);v=r['data'];v['attempts']=v.get('attempts',0)+1;v['error']=type(e).__name__+': '+str(e)[:180];v['retryAfter']=time.time()+30
        deterministic_review=isinstance(e,ValueError) and str(e) in ('Scan needs review; original retained','PDF requires document review; source retained')
        if (v['attempts']>=3 or deterministic_review) and r['state'] in ('PROCESSING','VERIFYING'):r['state']='NEEDS_REVIEW'
        cr.save(r)
        try:cr.sync_register(m)
        except Exception:pass
        return cr.get(rid)

async def main():
    from telegram import Bot
    adapter=SimpleNamespace(_bot=Bot(m._dotenv()['TELEGRAM_BOT_TOKEN']))
    pool=concurrent.futures.ThreadPoolExecutor(max_workers=2);running={}
    async with adapter._bot:
        while True:
            if cr.enabled():
                with cr.db() as c:rows=c.execute("SELECT id FROM receipts WHERE state IN ('PROCESSING','VERIFYING','FILING') OR json_extract(data,'$.retirementPending')=1 ORDER BY updated").fetchall()
                for row in rows:
                    if len(running)>=2:break
                    rid=row['id'];r=cr.get(rid)
                    if rid not in running and r['data'].get('retryAfter',0)<=time.time():running[rid]=pool.submit(work,rid)
                for rid,future in list(running.items()):
                    if not future.done():continue
                    running.pop(rid);r=future.result();v=r['data']
                    if r['state'] in ('UNCONFIGURED','NEEDS_REVIEW') and not v.get('batch') and not v.get('notified'):
                        await cr.card(adapter,m,r,v['chat']);r=cr.get(rid);r['data']['notified']=True;cr.save(r)
                with cr.db() as c:actors=[row['actor'] for row in c.execute('SELECT actor FROM settings')]
                for actor in actors:
                    s=cr.settings(actor);batch=s.get('closedBulk')
                    if not batch or s.get('bulkNotified'):continue
                    batch_rows=[r for r in cr.pending(actor) if r['data'].get('batch')==batch]
                    if not any(r['state'] in ('PROCESSING','VERIFYING') for r in batch_rows):
                        await cr.list_card(adapter,m,actor,s['bulkChat'],batch);cr.settings(actor,bulkNotified=True)
            await asyncio.sleep(2)

if __name__=='__main__':asyncio.run(main())
