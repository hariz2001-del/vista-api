"""Mechanical profile-only config extension; never reads/copies credentials."""
from pathlib import Path
import re
import shutil

home = Path('/home/ubuntu/.hermes/profiles/sarangbooks')
path = home / 'config.yaml'
text = path.read_text()
backup = path.with_name('config.yaml.before-direct-drive')
if not backup.exists():shutil.copy2(path, backup)
section = re.search(r'^mcp_servers:\n(.*?)(?=^\S|\Z)', text, re.M | re.S)
if not section:raise SystemExit('MCP configuration anchor missing; inspect first.')
drive = re.search(r'^  finances_drive:\n(.*?)(?=^  \S|\Z)', section.group(1), re.M | re.S)
bridge = '/home/ubuntu/.hermes/profiles/sarangbooks/integrations/drive_mcp.py'
if drive:
    if bridge not in drive.group(1):raise SystemExit('Existing finances_drive connection differs; preserve it and inspect.')
else:
    old = re.search(r'^  vista:\n(.*?)(?=^  \S|\Z)', section.group(1), re.M | re.S)
    command = re.search(r'^    command: (.+)$', old.group(1) if old else '', re.M)
    if not command:raise SystemExit('Expected finance Python command missing.')
    addition = '  finances_drive:\n    command: ' + command.group(1) + '\n    args:\n    - ' + bridge + '\n'
    text = text[:section.end()] + addition + text[section.end():]
platform = re.search(r'^platform_toolsets:\n(.*?)(?=^\S|\Z)', text, re.M | re.S)
telegram = re.search(r'^  telegram:\n(.*?)(?=^  [\w-]+:|\Z)', platform.group(1) if platform else '', re.M | re.S)
if not telegram:raise SystemExit('Telegram toolsets anchor missing.')
if '- finances_drive' not in telegram.group(1):
    anchor = '  - vista\n'
    if telegram.group(1).count(anchor) != 1:raise SystemExit('Expected Telegram Vista toolset anchor missing.')
    block = telegram.group(0).replace(anchor, anchor + '  - finances_drive\n')
    start = platform.start(1) + telegram.start()
    end = platform.start(1) + telegram.end()
    text = text[:start] + block + text[end:]
path.write_text(text)
print('Independent finances_drive MCP session and Telegram toolset enabled; credentials/model/other profiles preserved.')
