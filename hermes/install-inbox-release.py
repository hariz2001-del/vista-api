"""Scoped mechanical release; preserves existing profile credentials/config."""
import sys,shutil
from pathlib import Path
stage=Path(sys.argv[1]).resolve();home=Path('/home/ubuntu/.hermes/profiles/sarangbooks')
if stage.parent!=Path('/tmp') or not stage.name.startswith('chopper-release.'):raise SystemExit('Unexpected staging directory.')
files=('vista_mcp.py','receipt_form.py','receipt_inbox.py','receipt_maintenance.py','telegram_receipts.py','vista_actor_guard.py','receipt-worker-prompt.txt','install-telegram-receipts.py','update-receipt-worker.py','verify-live-inbox.py','verify-live-receipt-card.py','verify-actor-transport.py','verify-live-bulk.py')
for name in files:
    path=stage/name
    if not path.is_file():raise SystemExit('Incomplete release.')
    if name.endswith('.py'):compile(path.read_text(),str(path),'exec')
targets=[(stage/name,home/'integrations'/name) for name in files]+[(stage/'SOUL.md',home/'SOUL.md'),(stage/'SKILL.md',home/'skills/productivity/sarang-bookkeeping/SKILL.md')]
for source,target in targets:
    backup=target.with_name(target.name+'.before-inbox-v1')
    if target.exists() and not backup.exists():shutil.copy2(target,backup)
    shutil.copy2(source,target)
print('Installed scoped Chopper receipt release; credentials, config and other bots unchanged.')
