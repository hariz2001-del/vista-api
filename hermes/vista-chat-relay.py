"""Chopper in the Vista RMS: owner messages from Vista go to Hermes, answers go back.

Vista never calls this server. The relay claims one waiting message at a time.
A receipt photo goes straight into Chopper's receipt pipeline (the same as a
Telegram photo; the worker reads it and posts its card back to Vista). A question
goes to Hermes in one ongoing conversation ("vista-rms"), and the answer, with any
file Chopper made (MEDIA:/path lines), goes back to Vista.
"""
import os, sys, time, base64, mimetypes, re, subprocess
from pathlib import Path
sys.path.insert(0, '/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap  # noqa: F401  (sets up Hermes's own imports)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import vista_mcp as m
import urllib.request
import chopper_receipts as cr

HERMES = str(Path.home() / '.local/bin/hermes')
SESSION = 'vista-rms'
MAX_FILE = 3 * 1024 * 1024
CONTEXT = ('[Sent by the owner from the chat window in the Vista RMS, not Telegram. '
           'Answer in plain text: there are no buttons here. To give a file (a PDF or a picture), '
           'put its MEDIA:/path on its own line and Vista shows it as a download. '
           'Receipt photos still come in through Telegram.]\n\n')
MEDIA = re.compile(r'MEDIA:(\S+)')


def ask(text):
    run = subprocess.run(
        [HERMES, 'chat', '--query-file', '-', '-Q', '-p', 'sarangbooks', '--continue', SESSION, '--create-if-missing', '--source', 'vista'],
        input=CONTEXT + text, capture_output=True, text=True, timeout=900, cwd=str(Path.home()),
        # The relay runs inside the profile; Hermes picks the profile itself from -p.
        env={k: v for k, v in os.environ.items() if k != 'HERMES_HOME'},
    )
    lines = [l for l in run.stdout.splitlines()
             if not l.startswith('session_id:') and not l.startswith('↻ Resumed session') and 'found but has no messages' not in l]
    answer = '\n'.join(lines).strip()
    if run.returncode != 0 and not answer:
        raise RuntimeError((run.stderr or 'Hermes stopped')[-300:])
    return answer


def files_in(answer):
    files, kept = [], []
    for raw in MEDIA.findall(answer):
        path = Path(raw.strip('`"\'),.'))
        if path.is_file() and path.stat().st_size <= MAX_FILE and len(files) < 3:
            mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
            files.append({'name': path.name, 'mime': mime, 'base64': base64.b64encode(path.read_bytes()).decode()})
            kept.append(raw)
    text = answer
    for raw in kept:
        text = text.replace('MEDIA:' + raw, '')
    return re.sub(r'\n{3,}', '\n\n', text).strip(), files


def photo_bytes(message_id):
    base = m._setting("VISTA_API_URL", "https://api.vistahub.my").rstrip("/")
    request = urllib.request.Request(f"{base}/agent/chopper/chat/{message_id}/file", headers={
        "Authorization": f"Bearer {m._setting('VISTA_AGENT_KEY')}", "X-Telegram-User": m._default_user()})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def take_photo(message):
    """Into Chopper's pipeline at once: no model call before the read starts."""
    actor = str(m._default_user())
    data = photo_bytes(message['id'])
    chat = 'vista-chat' if message['kind'] == 'receipt' else 'vista-expenses'
    # Photos from Expenses and in a /bulk run are read quietly (no card of their own).
    batch = message.get('batch') or ('vista-expenses' if message['kind'] == 'upload' else None)
    mime = (message.get('file') or {}).get('mime') or 'image/jpeg'
    r, _ = cr.intake(m, actor, chat, str(message['id']), data, mime, batch=batch or '')
    m._call('POST', f"/agent/chopper/chat/{message['id']}/received", {'receiptKey': r['id']}, None)


def main():
    while True:
        try:
            message = (m._call('POST', '/agent/chopper/chat/claim', {}, None) or {}).get('message')
        except Exception as e:
            print('claim failed:', e, file=sys.stderr); time.sleep(10); continue
        if not message:
            time.sleep(2); continue
        if message.get('kind') in ('receipt', 'upload'):
            try:
                take_photo(message)
            except Exception as e:
                print('photo intake failed:', e, file=sys.stderr)
                try: m._call('POST', f"/agent/chopper/chat/{message['id']}/received", {'failed': True, 'text': "I couldn't take that photo in. Try sending it again."}, None)
                except Exception: pass
            continue
        try:
            text, files = files_in(ask(message['text']))
            body = {'text': text, 'files': files}
        except Exception as e:
            print('Hermes failed:', e, file=sys.stderr)
            body = {'text': "Sorry — I couldn't answer that just now. Try again in a moment.", 'failed': True}
        for attempt in range(5):
            try:
                m._call('POST', f"/agent/chopper/chat/{message['id']}/reply", body, None); break
            except Exception as e:
                print('reply failed, retrying:', e, file=sys.stderr); time.sleep(3 * (attempt + 1))


if __name__ == '__main__':
    main()
