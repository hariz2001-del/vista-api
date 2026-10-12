"""Read-only incident evidence; never posts or prints credentials."""
import sys, json
sys.path.insert(0, '/home/ubuntu/.hermes/profiles/sarangbooks/integrations')
import vista_mcp as m
rows=m._call('GET','/agent/receipts?order=newest&limit=50',telegram_user='304348232')['receipts']
rows.append(m._call('GET','/agent/receipts/e076b077-98f5-471c-95ec-64d6da08574d',telegram_user='304348232')['receipt'])
for r in rows:
    if 'speed' in (r.get('vendor') or '').lower() or r.get('ref')=='R-47A487':
        v=m._call('GET',f'/agent/receipts/{r["id"]}/form',telegram_user='304348232')
        print(json.dumps(v))
