"""Live API + installed native renderer; mock ONLY Telegram UI edits.

Does not post, edit extraction, configure a draft or send another notification.
The real owner's click-through remains a separate acceptance check.
"""
import asyncio, os, sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
sys.path.insert(0,'/home/ubuntu/.hermes/profiles/sarangbooks/integrations')
import vista_mcp as m, telegram_receipts as transport, receipt_form as form
RID='8fba706a-633f-46d1-9472-115fe6c079d4'
class Query:
    id='live-readonly-check'
    def __init__(self,user='304348232'):
        self.from_user=SimpleNamespace(id=user,full_name='Owner');self.message=SimpleNamespace(chat=SimpleNamespace(id=user));self.edits=[];self.alerts=[]
    async def answer(self,*a,**kw):self.alerts.append((a,kw))
    async def edit_message_text(self,**kw):self.edits.append(kw)
class Adapter:
    _update_receipt_dir=transport.HOME
    def __init__(self):self._bot=self;self.notices=[]
    async def send_message(self,**kw):self.notices.append(kw)
async def main():
    a=Adapter();q=Query();transport.bridge=lambda:m
    before=m._call('GET',f'/agent/receipts/{RID}',telegram_user='304348232')['receipt']
    view=m._call('GET',f'/agent/receipts/{RID}/form',telegram_user='304348232')
    assert len(view['form']['lines'])==4 and view['receipt']['totalSen']==7610
    await transport.callback(a,q,f'vr:{RID}:key')
    assert q.edits and 'RM76.10' in q.edits[-1]['text']
    labels=[]
    for field in ('c','b','f','m'):
        await form.callback(a,q,f'vf:{RID}:pick:{field}:{"a" if field in ("f","m") else "0"}:0',m)
        labels.append([b.text for row in q.edits[-1]['reply_markup'].inline_keyboard for b in row])
    assert all(x['label'] in labels[0] for x in view['options']['categories'])
    assert all(x['name'] in labels[1] for x in view['options']['brands'])
    # Vista defaults are shown once; Save previews but never posts.
    view=m._call('GET',f'/agent/receipts/{RID}/form',telegram_user='304348232')
    await form.callback(a,q,f'vf:{RID}:save:{form.stamp(view)}',m)
    assert q.edits and 'NOT saved yet' in q.edits[-1]['text'], a.notices
    labels=[b.text for row in form.keyboard(view) for b in row if 'text' in b]
    assert sum(x.startswith('Brand:') for x in labels)==1
    denied=Query('999999999999');await transport.callback(a,denied,f'vr:{RID}:key')
    assert not denied.edits
    after=m._call('GET',f'/agent/receipts/{RID}',telegram_user='304348232')['receipt']
    assert before['status']==after['status']=='PENDING_REVIEW' and before['expenses']==after['expenses']==[]
    assert after['driveUrl'] and after['scanDriveUrl']
    print({'receipt':after['ref'],'lineCount':len(view['form']['lines']),'nativeCard':'PASS','oneGroupBrand':'PASS','saveIsPreviewOnly':'PASS','unregisteredActorBlocked':'PASS','realExpenseWrites':0,'originalAndScanDriveIdsPresent':True})
asyncio.run(main())
