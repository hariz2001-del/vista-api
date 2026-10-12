"""Update only the existing Chopper receipt job through Hermes' CLI."""
import os, subprocess
from pathlib import Path
home=Path('/home/ubuntu/.hermes/profiles/sarangbooks')
prompt=(home/'integrations/receipt-worker-prompt.txt').read_text()
result=subprocess.run(['/home/ubuntu/.local/bin/hermes','cron','edit','60522e453a6e','--prompt',prompt,'--name','Chopper receipt processing','--model','gpt-6-luna','--reasoning-effort','low'],env=dict(os.environ,HERMES_HOME=str(home)),capture_output=True,text=True)
if result.returncode:raise SystemExit('Worker update failed; no credentials logged. Inspect the scoped cron job.')
print('Chopper receipt worker updated: evidence + annotation only, Luna/low; no expense/roster/stock mutations.')
