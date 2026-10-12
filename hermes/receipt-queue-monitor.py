"""Wake evidence worker for queue work OR completed Drive changes awaiting sync."""
import importlib.util
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

home = Path('/home/ubuntu/.hermes/profiles/sarangbooks')
path = home / 'integrations/vista_mcp.py'
spec = importlib.util.spec_from_file_location('vista_queue_bridge', path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
user = m._setting('VISTA_BACKGROUND_TELEGRAM_USER')
if not user:raise SystemExit('Background worker user binding missing')
now = datetime.now(timezone.utc)
jobs = m._call('GET', '/agent/queue?eligible=true', telegram_user=user)['jobs']
eligible = [{'id': j['id'], 'attempts': j['attempts']} for j in jobs if j['attempts'] < 5 and (j['status'] == 'PENDING' or j['status'] == 'RUNNING' and j['leaseUntil'] and datetime.fromisoformat(j['leaseUntil'].replace('Z', '+00:00')) < now)]
pending = []
database = home / 'cache/direct-drive/operations.sqlite3'
if database.exists():
    db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    try:
        pending = [r[0] for r in db.execute("SELECT id FROM operations WHERE actor=? AND state='drive_done' ORDER BY made LIMIT 50", (user,))]
    finally:db.close()
print(json.dumps({'eligible': eligible, 'pendingDriveSync': pending}, sort_keys=True))
