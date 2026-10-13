"""Profile-only cutover, preserving upstream adapter and runtime rollback."""
from pathlib import Path
import shutil,subprocess,sys
HOME=Path('/home/ubuntu/.hermes/profiles/sarangbooks')
repo=Path('/home/ubuntu/.hermes/hermes-agent')
backup=HOME/'backups/drive-first-20261014';backup.mkdir(parents=True,exist_ok=True,mode=0o700)
adapter=repo/'plugins/platforms/telegram/adapter.py'
text=adapter.read_text();old="if data.startswith(('vr:', 'vf:', 'vi:', 'vm:', 'dg:')):"
new="if data.startswith(('vr:', 'vf:', 'vi:', 'vm:', 'dg:', 'cr:')):"
if old in text:
    if not (backup/'adapter.py').exists():shutil.copy2(adapter,backup/'adapter.py')
    if text.count(old)!=1:raise SystemExit('Native callback anchor changed')
    text=text.replace(old,new);compile(text,str(adapter),'exec');adapter.write_text(text)
elif new not in text:raise SystemExit('Native callback anchor missing')
soul=HOME/'SOUL.md'
if not (backup/'SOUL.md').exists():shutil.copy2(soul,backup/'SOUL.md')
policy='''

## CHOPPER_DRIVE_FIRST_V1 — supersedes ALL earlier receipt intake/storage instructions
Receipt intake and pending choices belong to Chopper, not Vista. Incoming photos and /bulk
are handled by native Drive-first hooks. Use chopper_receipts(action=list/get/edit) for pending
receipts. Never use legacy vista_upload_receipt, vista_receipt_form/inbox, vista_post/preview,
vista_save_reading/scan/drive_sync to handle new receipts. Existing Vista financial reads remain.
Unconfigured and Configured have no date subfolders. Only an exact native owner-confirmed
submission creates Vista receipt/expense records; then the scan moves to Submitted/YYYY/MM.
The one pending-receipts.jsonl file stores temporary readings and choices, linked by immutable
receipt keys and actual Drive IDs. Do not edit that file manually: the native queue owns it.
Native buttons ask live Vista category, brand, funding, payment and optional split fields.
For reading changes use chopper_receipts edit with exact corrected structured data; never
invent missing values. Fields use integer sen and quantityMilli (1000 = one). Preserve uncertainty.
The writer is ordinary code behind the native confirmation, not a posting model. Never post
then refund or reverse to recover an uncertain request. Native recovery uses the same submission ID.
Luna reads actual images; real-pixel scan code crops/deskews/perspective flattens without redrawing.
Originals go to recoverable Trash ONLY after scan verification and Drive/index readback.
Uncertain scans retain originals. Full curved-paper restoration or hidden-text recovery is not guaranteed.
/bulk stays silent per photo; /endbulk closes intake and lists stored receipts. Select by number,
configure, preview and confirm. Next receipt is user-requested, not automatically opened.
No separate Telegram bots, model provider or agent framework: all model-backed tasks use
Hermes on gpt-6-luna with the existing provider. Chopper is the owner-facing orchestrator.
'''
original=soul.read_text()
if 'CHOPPER_DRIVE_FIRST_V1' not in original:soul.write_text(original+policy)
unit=HOME/'.service-drive-first'
unit.write_text('[Unit]\nDescription=Chopper Drive-first receipt queue\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory='+str(HOME/'integrations')+'\nEnvironment=HERMES_HOME='+str(HOME)+'\nExecStart='+sys.executable+' '+str(HOME/'integrations/chopper-receipt-worker.py')+'\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n')
target=Path('/home/ubuntu/.config/systemd/user/hermes-chopper-receipts.service')
shutil.copy2(unit,target)
(HOME/'drive-first.enabled').write_text('2026-10-14\n')
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now','hermes-chopper-receipts.service'],check=True)
subprocess.run(['systemctl','--user','reload','hermes-gateway'],check=True)
print('Drive-first hooks and queue enabled for Chopper; gateway reloaded. Backup: '+str(backup))
