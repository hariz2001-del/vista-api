#!/usr/bin/env python3
"""Enable skill lookup alongside the existing Books-only toolsets."""
from pathlib import Path
import re

def enable(text):
    section = re.search(r'(?ms)^platform_toolsets:\n.*?(?=^\S|\Z)', text)
    if not section: raise ValueError('Missing platform toolsets; inspect before updating.')
    telegram = re.search(r'(?m)^  telegram:\n((?:    - [^\n]+\n)+)', section.group())
    if not telegram: raise ValueError('Telegram toolsets changed; inspect before updating.')
    # known_builtin_toolsets is discovery metadata, NOT the enabled tool list.
    if '    - skills\n' in telegram.group(1): return text
    position = section.start() + telegram.end(1)
    return text[:position] + '    - skills\n' + text[position:]

if __name__ == '__main__':
    config = Path('/home/ubuntu/.hermes/profiles/sarangbooks/config.yaml')
    original = config.read_text()
    updated = enable(original)
    if updated != original: config.write_text(updated)
    config.chmod(0o600)
    print('Telegram skill lookup is enabled in platform_toolsets; other toolsets preserved.')
