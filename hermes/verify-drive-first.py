"""Read-only deployed story checks; optionally deliver the native owner inbox.

Never submits an expense, invents an owner confirmation, or refunds a test.
"""
import sys
from pathlib import Path
sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
sys.path.insert(0,str(Path(__file__).resolve().parent))
import asyncio,json
from collections import Counter
from types import SimpleNamespace
import chopper_receipts as cr
import vista_mcp as m

actor='304348232'
context=cr.authorise(m,actor)
rows=cr.pending(actor);d=cr.service(m)
with cr.db() as c:register=c.execute("SELECT value FROM meta WHERE key='register'").fetchone()['value']
stored=d.request('/files/'+register+'?alt=media',raw=True).decode()
indexed=[json.loads(line) for line in stored.splitlines() if line]
assert {r['id'] for r in rows}=={r['id'] for r in indexed},'Pending register mismatch'
assert all(r['business']==context['businessId'] for r in rows),'Business mismatch'
print(json.dumps({'states':dict(Counter(r['state'] for r in rows)),'registerRows':len(indexed),'vistaDraftsWritten':False}))
if '--send-inbox' in sys.argv:
    from telegram import Bot
    async def send():
        async with Bot(m._dotenv()['TELEGRAM_BOT_TOKEN']) as bot:
            await cr.list_card(SimpleNamespace(_bot=bot),m,actor,actor)
    asyncio.run(send())
    print('Native inbox delivered. No expense submitted.')
