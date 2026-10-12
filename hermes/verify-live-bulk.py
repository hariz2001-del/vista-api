"""Read-only release checks; no live mode changes, deletion or financial writes."""
import sys,json,urllib.request
sys.path.insert(0,'/home/ubuntu/.hermes/profiles/sarangbooks/integrations')
import vista_mcp as m,receipt_inbox as inbox
USER='304348232'
settings=m._call('GET','/agent/inbox/settings',telegram_user=USER)
preferences=m._call('GET','/agent/preferences',telegram_user=USER)
assert 'shared business' in preferences['scope']
text,rows=inbox.card({'listId':'1','listScope':'batch','entries':[{'number':1,'ref':'R-5AE50F','vendor':'BWY Holdings','date':'2026-10-09','totalSen':3520,'flags':[]}]})
assert text=='1. R-5AE50F — BWY Holdings · 09/10/2026 · RM 35.20'
assert [b['text'] for row in inbox.progress('x') for b in row]==['Next receipt','End','Choose custom receipt']
token=m._dotenv().get('TELEGRAM_BOT_TOKEN','')
scopes=('default','all_private_chats','all_group_chats')
for scope in scopes:
    req=urllib.request.Request('https://api.telegram.org/bot'+token+'/getMyCommands',data=json.dumps({'scope':{'type':scope}}).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=30) as response:result=json.load(response)
    names=[r['command'] for r in result['result']]
    assert 'bulk' in names and 'endbulk' in names,(scope,names)
try:m._call('GET','/agent/preferences',telegram_user='999999999999')
except m.VistaError:pass
else:raise AssertionError('Unknown actor accepted')
print(json.dumps({'slashCommands':'PASS all scopes','sharedPreferences':'PASS','numberedFormat':'PASS','manualAdvanceButtons':'PASS','bulkActive':settings['bulk'],'liveFinancialWrites':0,'livePhotosDeleted':0}))
