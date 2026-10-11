#!/usr/bin/env python3
"""Renew the existing Google connection and share only Drive credentials with Books.

Called by the local loopback OAuth helper; never logs credentials.
"""
import json
import os
import pathlib
import pwd
import sys
import tempfile

token_path = pathlib.Path('/var/lib/sarang/drive/token.json')
info = json.loads(sys.stdin.read())
if not all(isinstance(info.get(key), str) and info[key] for key in ('client_id', 'client_secret', 'refresh_token')):
    raise SystemExit('Missing Google credentials')
fd, temp = tempfile.mkstemp(prefix='.renew-', dir=token_path.parent)
with os.fdopen(fd, 'w') as stream:
    json.dump(info, stream)
owner = pwd.getpwnam('sarangsvc')
os.chown(temp, owner.pw_uid, owner.pw_gid)
os.chmod(temp, 0o600)
os.replace(temp, token_path)

profile = pathlib.Path('/home/ubuntu/.hermes/profiles/sarangbooks/.env')
values = {
    'GOOGLE_CLIENT_ID': info['client_id'], 'GOOGLE_CLIENT_SECRET': info['client_secret'],
    'GOOGLE_REFRESH_TOKEN': info['refresh_token'],
}
lines = [line for line in profile.read_text().splitlines() if line.partition('=')[0] not in values]
profile.write_text('\n'.join(lines + [key + '=' + value for key, value in values.items()]) + '\n')
profile_owner = pwd.getpwnam('ubuntu')
os.chown(profile, profile_owner.pw_uid, profile_owner.pw_gid)
os.chmod(profile, 0o600)
print('Google connection renewed; Drive credentials shared with Sarang Books securely.')
