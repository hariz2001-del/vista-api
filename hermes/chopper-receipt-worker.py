"""Chopper durable queue: plain code owns all effects; vision children read only."""
import sys,asyncio,concurrent.futures,time
from pathlib import Path
sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
sys.path.insert(0,str(Path(__file__).resolve().parent))
from types import SimpleNamespace
import vista_mcp as m
import chopper_receipts as cr

def due(r):
    """What the worker should do with this receipt now, if anything."""
    v=r['data']
    if r['state']=='SUBMITTED':return cr.needs_refile(r)
    if r['state'] in ('PROCESSING','FILING') or v.get('retirementPending'):return True
    # Photo upload interrupted (restart mid-intake): pick it up after a while.
    if r['state']=='RECEIVING':return time.time()-r['updated']>300
    if cr.needs_rescan(r) and v.get('rescanTried')!=cr.SCANNER:return True
    if cr.needs_recheck(r):return True
    if cr.needs_sumfix(r):return True
    if cr.needs_record(r):return True
    return bool(v.get('scanVerified')) and not v.get('sourceRetired') and r['state'] in ('UNCONFIGURED','CONFIGURED')

def work(rid):
    # Same per-receipt lock as the bot's taps: the worker never files, scans or retires
    # a receipt while the owner is booking it, and re-checks it once the lock is held.
    with cr.receipt_lock(rid):
        return locked_work(rid)

def locked_work(rid):
    try:
        r=cr.get(rid);v=r['data']
        if not due(r):return r
        if r['state']=='SUBMITTED':return cr.refile(m,r)
        if r['state']=='FILING':return cr._finish_filing(m,r)
        if v.get('retirementPending'):return cr.retire_source(m,r)
        if r['state']=='RECEIVING':r['state']='PROCESSING';cr.save(r);return cr.process(m,rid)
        if cr.needs_rescan(r) and v.get('rescanTried')!=cr.SCANNER:
            v['rescanTried']=cr.SCANNER;r=cr.save(r);return cr.rescan(m,r)
        if cr.needs_recheck(r):return cr.recheck(m,r)
        if cr.needs_sumfix(r):return cr.sumfix(m,r)
        if cr.needs_record(r):return cr.record_in_vista(m,r)
        if v.get('scanVerified') and not v.get('sourceRetired') and r['state'] in ('UNCONFIGURED','CONFIGURED'):return cr.retire_source(m,r)
        return cr.process(m,rid)
    except Exception as e:
        r=cr.get(rid);v=r['data'];v['attempts']=v.get('attempts',0)+1;v['error']=type(e).__name__+': '+str(e)[:220];v['retryAfter']=time.time()+min(300,30*v['attempts'])
        if v['attempts']>=3 and r['state']=='PROCESSING':r['state']='NEEDS_REVIEW'
        cr.save(r)
        try:cr.sync_register(m)
        except Exception:pass
        return cr.get(rid)

async def main():
    from telegram import Bot
    adapter=SimpleNamespace(_bot=Bot(m._dotenv()['TELEGRAM_BOT_TOKEN']))
    pool=concurrent.futures.ThreadPoolExecutor(max_workers=2);running={}
    sorter=concurrent.futures.ThreadPoolExecutor(max_workers=1);sorting=None;last_poll=0
    async with adapter._bot:
        while True:
            if cr.enabled() and not (cr.HOME/'receipts-paused').exists():
                with cr.db() as c:rows=c.execute("SELECT id FROM receipts WHERE state NOT IN ('RETIRED','SUBMITTING') ORDER BY rowid").fetchall()
                for row in rows:
                    if len(running)>=2:break
                    rid=row['id'];r=cr.get(rid)
                    if rid not in running and due(r) and r['data'].get('retryAfter',0)<=time.time():running[rid]=pool.submit(work,rid)
                for rid,future in list(running.items()):
                    if not future.done():continue
                    running.pop(rid);r=future.result();v=r['data']
                    if cr.from_vista(r):
                        # Sent from the Vista RMS: its card (if any) goes back there, once read.
                        if r['state'] in ('UNCONFIGURED','NEEDS_REVIEW') and not v.get('notified'):
                            try:await asyncio.to_thread(cr.vista_card,m,r);r=cr.get(rid);r['data'].update(notified=True,alerted=True);cr.save(r)
                            except Exception as e:print('Vista card failed, will retry:',e,file=sys.stderr)
                    elif r['state'] in ('UNCONFIGURED','NEEDS_REVIEW') and not v.get('batch') and not v.get('notified'):
                        # The card carries any problem or warning itself.
                        await cr.card(adapter,m,r,v['chat']);r=cr.get(rid);r['data'].update(notified=True,alerted=True);cr.save(r)
                    elif cr.alert_text(r) and not v.get('alerted') and r['state'] in ('UNCONFIGURED','NEEDS_REVIEW','CONFIGURED'):
                        # Problems are told straight away, in /bulk too, and after a re-scan.
                        p='cr:'+rid+':'
                        rows=[[cr.button('View scan',p+'scan'),cr.button('Open',p+'open')]]
                        if v.get('problem'):rows.insert(0,[cr.button('View original',p+'original'),cr.button('Retry scan',p+'retry')])
                        await adapter._bot.send_message(chat_id=v['chat'],text=cr.alert_text(r),reply_markup=cr.markup(rows))
                        r=cr.get(rid);r['data']['alerted']=True;cr.save(r)
                with cr.db() as c:actors=[row['actor'] for row in c.execute('SELECT actor FROM settings')]
                for actor in actors:
                    s=cr.settings(actor);batch=s.get('closedBulk')
                    if not batch or s.get('bulkNotified'):continue
                    batch_rows=[r for r in cr.pending(actor) if r['data'].get('batch')==batch]
                    if not any(r['state']=='PROCESSING' for r in batch_rows):
                        try:await cr.list_card(adapter,m,actor,s['bulkChat'],batch)
                        except Exception as e:print('Bulk list failed:',e,file=sys.stderr)
                        cr.settings(actor,bulkNotified=True)
                # What the owner sorted in the RMS: applied, filed, and told on Telegram.
                if sorting is None and time.time()-last_poll>4:sorting=sorter.submit(cr.vista_events,m);last_poll=time.time()
                if sorting is not None and sorting.done():
                    try:notes=sorting.result()
                    except Exception as e:print('RMS sort poll failed:',e,file=sys.stderr);notes=[]
                    sorting=None
                    for note in notes:
                        if note.get('chat') and not str(note['chat']).startswith('vista'):
                            try:await adapter._bot.send_message(chat_id=note['chat'],text=note['text'],reply_markup=cr.markup(note['rows']))
                            except Exception as e:print('RMS sort message failed:',e,file=sys.stderr)
            await asyncio.sleep(2)

if __name__=='__main__':asyncio.run(main())
