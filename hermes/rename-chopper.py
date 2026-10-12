"""Rename only the finance bot display name; username/credentials stay intact."""
import importlib.util, json, urllib.request
from pathlib import Path
path=Path('/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py')
spec=importlib.util.spec_from_file_location('finance_bridge',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
token=m._dotenv().get('TELEGRAM_BOT_TOKEN')
if not token:raise SystemExit('Finance credential missing; nothing changed.')
def call(method,body):
    req=urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=20) as response:result=json.load(response)
    except Exception:raise SystemExit('Telegram request failed; credential not logged.') from None
    if not result.get('ok'):raise SystemExit('Telegram rejected the name change.')
    return result['result']
call('setMyName',{'name':'Chopper'})
bot=call('getMe',{})
assert bot['first_name']=='Chopper'
print({'name':bot['first_name'],'username':bot.get('username'),'verified':True})
