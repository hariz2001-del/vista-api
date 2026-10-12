"""Check live boundaries; metadata checks only, no posting/editing/deleting."""
import json,sys
sys.path.insert(0,'/home/ubuntu/.hermes/profiles/sarangbooks/integrations')
import vista_mcp as m,receipt_form as form,receipt_inbox as inbox
USER='304348232';speed='e076b077-98f5-471c-95ec-64d6da08574d'
v=m._call('GET',f'/agent/receipts/{speed}/form',telegram_user=USER)
expense_ids=[e['id'] for e in v['receipt']['expenses']]
assert len(expense_ids)==1 and v['receipt']['totalSen']==1795 and v['readOnly']
assert v['workflow']['postedSen']==1795 and not v['matches']
print('Speed Mart: exactly one RM17.95 entry; own allocation not flagged as duplicate.',flush=True)
edit=m._call('GET',f'/agent/expenses/{expense_ids[0]}/edit',telegram_user=USER)
assert edit['expense']['amountSen']==1795
settings=m._call('GET','/agent/inbox/settings',telegram_user=USER)
rows=m._call('GET','/agent/receipts?status=OPEN&order=oldest&limit=50',telegram_user=USER)['receipts']
checked=0
for r in rows:
    if not (r.get('extracted') or {}).get('lines') and (r.get('extracted') or {}).get('document_type')!='bank_screenshot':continue
    m._call('POST',f'/agent/receipts/{r["id"]}/checks',{},USER)
    checked+=1;print('Cross-check metadata refreshed: '+r['ref'],flush=True)
result=m._call('POST','/agent/inbox/review',{'order':'flags'},USER)
text,buttons=inbox.card(result)
assert (not result['entries'] or text.startswith('1. R-')) and all(len(b['callback_data'].encode())<=64 for row in buttons for b in row)
if result['entries']:
    view=m._call('GET',f'/agent/receipts/{result["entries"][0]["id"]}/form',telegram_user=USER)
    assert view['form']['paidBy']=='STALL_FUNDS'
    labels=[b['text'] for row in form.keyboard(view) for b in row]
    assert any(l.startswith('Funding: ') for l in labels) or view['readOnly'] or not view['form']['lines']
try:m._call('GET','/agent/inbox/settings',telegram_user='999999999999')
except m.VistaError:pass
else:raise AssertionError('Unknown actor accepted')
after=m._call('GET',f'/agent/receipts/{speed}/form',telegram_user=USER)
assert [e['id'] for e in after['receipt']['expenses']]==expense_ids
print(json.dumps({'liveInbox':'PASS','ready':sum(e['ready'] for e in result['entries']),'listed':len(result['entries']),'total':result['total'],'metadataChecks':checked,'autoStash':settings['autoStash'],'expenseWrites':0,'filesDeleted':0,'unregisteredActorBlocked':True,'nativeButtons':'PASS'}),flush=True)
