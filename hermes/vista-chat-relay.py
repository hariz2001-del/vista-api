"""Chopper in the Vista RMS: owner messages from Vista go to Hermes, answers go back.

Vista never calls this server. The relay claims one waiting message at a time,
asks Hermes in one ongoing conversation ("vista-rms"), and posts the answer,
with any file Chopper made (MEDIA:/path lines), back to Vista.
"""
import os, sys, time, base64, mimetypes, re, subprocess
from pathlib import Path
sys.path.insert(0, '/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap  # noqa: F401  (sets up Hermes's own imports)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import vista_mcp as m

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


def main():
    while True:
        try:
            message = (m._call('POST', '/agent/chopper/chat/claim', {}, None) or {}).get('message')
        except Exception as e:
            print('claim failed:', e, file=sys.stderr); time.sleep(10); continue
        if not message:
            time.sleep(2); continue
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
