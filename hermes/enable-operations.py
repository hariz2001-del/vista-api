#!/usr/bin/env python3
"""Enable skill lookup alongside the existing Books-only toolsets."""
from pathlib import Path
profile = Path('/home/ubuntu/.hermes/profiles/sarangbooks')
config = profile / 'config.yaml'
text = config.read_text()
if '    - skills\n' not in text:
    old = '    - memory\n    - vista\n'
    if old not in text:
        raise SystemExit('Profile toolsets changed; inspect before updating.')
    text = text.replace(old, '    - memory\n    - skills\n    - vista\n', 1)
    config.write_text(text)
    config.chmod(0o600)
print('Sarang Books skill lookup enabled; Vista remains the business/Drive bridge.')
