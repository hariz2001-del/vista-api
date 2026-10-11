"""Cron monitor: no model call when there is no eligible receipt work."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
path = Path('/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py')
spec = importlib.util.spec_from_file_location('vista_queue_bridge', path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
user = m._setting('VISTA_BACKGROUND_TELEGRAM_USER')
if not user: raise SystemExit('Background worker user binding missing')
now = datetime.now(timezone.utc)
jobs = m._call('GET', '/agent/queue?eligible=true', telegram_user=user)['jobs']
eligible = [ {'id': j['id'], 'attempts': j['attempts']} for j in jobs if j['attempts'] < 5 and (j['status'] == 'PENDING' or j['status'] == 'RUNNING' and j['leaseUntil'] and datetime.fromisoformat(j['leaseUntil'].replace('Z', '+00:00')) < now) ]
print(json.dumps({'eligible': eligible}, sort_keys=True))
