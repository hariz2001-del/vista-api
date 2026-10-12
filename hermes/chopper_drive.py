"""Independent Google Drive client for Chopper. Tokens never enter tool output.

Drive operations do not use Vista as a proxy. Receipt change notifications are
separate, durable jobs; a failed Vista sync never repeats a Drive mutation.
Only a real Telegram callback may confirm replacement/trash/restore.
"""
import asyncio
from contextlib import contextmanager
import hashlib
import json
import re
import sqlite3
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://www.googleapis.com/drive/v3'
UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
FOLDER = 'application/vnd.google-apps.folder'
SHORTCUT = 'application/vnd.google-apps.shortcut'
FIELDS = 'id,name,mimeType,parents,trashed,version,md5Checksum,size,webViewLink,appProperties,capabilities(canEdit,canAddChildren,canTrash)'
LIMIT = 3 * 1024 * 1024


class Drive:
    def __init__(self, bridge, actor):
        self.m = bridge
        self.actor = str(actor or '')
        # Explicit owner binding is profile-local, independent of Vista uptime.
        self.owner = bridge._setting('CHOPPER_DRIVE_OWNER_ID', '304348232')
        if self.actor != self.owner:
            raise PermissionError('Direct Finances file control is owner-only. Never substitute another actor.')
        self.root = bridge._setting('DRIVE_FINANCES_FOLDER_ID')
        if not self.root:
            raise ValueError('Finances folder is not configured.')
        self.token = None

    def request(self, path, method='GET', body=None, raw=False, upload=False, mime=None):
        if self.token is None:
            data = urllib.parse.urlencode({
                'client_id': self.m._setting('GOOGLE_CLIENT_ID'),
                'client_secret': self.m._setting('GOOGLE_CLIENT_SECRET'),
                'refresh_token': self.m._setting('GOOGLE_REFRESH_TOKEN'),
                'grant_type': 'refresh_token',
            }).encode()
            req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
            try:
                with urllib.request.urlopen(req, timeout=20) as response:
                    self.token = json.load(response)['access_token']
            except Exception:
                raise ValueError('Google sign-in failed. Check or renew the saved connection; credentials are not logged.') from None
        headers = {'Authorization': 'Bearer ' + self.token}
        if body is not None:
            headers['Content-Type'] = (mime or 'application/octet-stream') if raw else 'application/json'
        data = body if raw else json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request((UPLOAD if upload else API) + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=40) as response:
                data = response.read(LIMIT + 1) if raw and method == 'GET' else response.read()
                if raw and method == 'GET':
                    if len(data) > LIMIT:
                        raise ValueError('File exceeds the 3 MB image/document download limit.')
                    return data
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as error:
            raise ValueError(f'Google Drive rejected {method} ({error.code}); no credentials logged.') from None

    def meta(self, file_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{5,200}', str(file_id)):
            raise ValueError('Use an actual Google Drive file ID, not a receipt R-reference or UUID.')
        return self.request('/files/' + file_id + '?' + urllib.parse.urlencode({'fields': FIELDS}))

    def scoped(self, file_id, allow_trash=False):
        original = self.meta(file_id)
        if original['mimeType'] == SHORTCUT:
            raise ValueError('Shortcuts are not supported; select the actual file inside Finances.')
        queue, seen = [original], set()
        while queue and len(seen) < 100:
            current = queue.pop(0)
            if current['id'] in seen:
                continue
            seen.add(current['id'])
            if current.get('trashed') and not allow_trash:
                continue
            if current['id'] == self.root:
                if current.get('trashed'):
                    raise ValueError('Finances root is unavailable.')
                return original
            queue += [self.meta(parent) for parent in current.get('parents', [])]
        raise ValueError('File is outside Finances or has no verifiable Finances ancestry.')

    def listing(self, parent=None, page=None, trashed=False):
        folder = self.scoped(parent or self.root)
        if folder['mimeType'] != FOLDER:
            raise ValueError('Select a folder.')
        args = {'q': f"'{folder['id']}' in parents and trashed = {'true' if trashed else 'false'}", 'fields': 'nextPageToken,files(' + FIELDS + ')', 'pageSize': 100, 'orderBy': 'folder,name'}
        if page:
            args['pageToken'] = page
        return self.request('/files?' + urllib.parse.urlencode(args))

    @contextmanager
    def db(self):
        directory = self.m.PROFILE / 'cache' / 'direct-drive'
        directory.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(directory / 'operations.sqlite3', timeout=10)
        db.execute('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, made REAL NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, result TEXT)')
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def fingerprint(file):
        return hashlib.sha256(json.dumps({k: file.get(k) for k in ['id', 'version', 'md5Checksum', 'parents', 'name', 'trashed']}, sort_keys=True).encode()).hexdigest()

    def cached_bytes(self, path):
        path = Path(path).resolve()
        if not path.is_relative_to((self.m.PROFILE / 'cache').resolve()) or not path.is_file():
            raise ValueError('Replacement must be an inspected file in Chopper’s cache, not an arbitrary local path.')
        if path.stat().st_size > LIMIT:
            raise ValueError('Replacement exceeds 3 MB.')
        return path.read_bytes()

    def preview(self, args):
        operation = args['operation']
        if operation not in ('replace', 'trash', 'restore'):
            raise ValueError('Choose replace, trash or restore.')
        file = self.scoped(args['file_id'], allow_trash=operation == 'restore')
        if file['id'] == self.root:
            raise ValueError('Finances root cannot be replaced or removed.')
        if file['mimeType'] == FOLDER:
            if operation == 'replace':
                raise ValueError('A folder has no replaceable image content.')
            if operation == 'trash' and (self.listing(file['id'])['files'] or self.listing(file['id'], trashed=True)['files']):
                raise ValueError('Preview and remove the contents first; non-empty folders cannot be trashed as a hidden bulk deletion.')
        payload = {'operation': operation, 'file': file, 'fingerprint': self.fingerprint(file), 'reason': str(args.get('reason', '')).strip()[:1000]}
        if not payload['reason']:
            raise ValueError('Explain the user-requested purpose of this change.')
        if operation == 'replace':
            if file['mimeType'].startswith('application/vnd.google-apps.'):
                raise ValueError('Native Docs/Sheets require their document editor, not binary image replacement.')
            data = self.cached_bytes(args['local_path'])
            signatures = {'image/jpeg': lambda b: b.startswith(b'\xff\xd8\xff'), 'image/png': lambda b: b.startswith(b'\x89PNG\r\n\x1a\n'), 'application/pdf': lambda b: b.startswith(b'%PDF-'), 'image/webp': lambda b: b.startswith(b'RIFF') and b[8:12] == b'WEBP'}
            if file['mimeType'] in signatures and not signatures[file['mimeType']](data):
                raise ValueError('Replacement must have the same real image/PDF format as the target; convert the scan first.')
            payload.update(local_path=str(Path(args['local_path']).resolve()), sha256=hashlib.sha256(data).hexdigest())
        ident = uuid.uuid4().hex
        with self.db() as db:
            db.execute('INSERT INTO operations VALUES (?,?,?,?,?,NULL)', (ident, self.actor, time.time(), 'preview', json.dumps(payload)))
        return {'confirmation_id': ident, 'operation': operation, 'file': file, 'reason': payload['reason'], 'note': 'Not changed. Owner confirmation required. Replacement archives old bytes; trash is recoverable. Accounting is unchanged.'}

    def sync(self, ident, result):
        event = {'operationId': ident, 'fileId': result['file']['id'], 'operation': result['operation'], 'sha256': result.get('sha256'), 'backupFileId': result.get('backup_file_id')}
        try:
            synced = self.m._call('POST', '/agent/drive/changes', {k: v for k, v in event.items() if v is not None}, self.actor)
        except Exception:
            return {**result, 'vista_sync': 'pending', 'note': 'Drive action completed. Vista synchronization is pending; do not repeat the Drive action.'}
        with self.db() as db:
            db.execute('UPDATE operations SET state=? WHERE id=?', ('synced', ident))
        return {**result, 'vista_sync': 'synced', 'receipt_ids': synced.get('receiptIds', [])}

    def confirm(self, ident):
        # Not exposed as a model tool. Called only by authenticated Telegram UI.
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT actor,made,state,payload,result FROM operations WHERE id=?', (ident,)).fetchone()
            if not row or row[0] != self.actor:
                raise PermissionError('This confirmation belongs to another actor or does not exist.')
            actor, made, state, encoded, result = row
            if state in ('drive_done', 'synced'):
                saved = json.loads(result)
                db.commit() # Release SQLite writer lock before separate sync job.
                return self.sync(ident, saved) if state == 'drive_done' else {**saved, 'vista_sync': 'synced', 'already_completed': True}
            if state != 'preview':
                raise ValueError('Operation is cancelled, already running, or needs reconciliation. Do not blindly retry.')
            if time.time() - made > 900:
                raise ValueError('Confirmation expired. Ask for a fresh preview.')
            target_id = json.loads(encoded)['file']['id']
            busy = db.execute("SELECT payload FROM operations WHERE state='running' AND id<>?", (ident,)).fetchall()
            if any(json.loads(entry[0])['file']['id'] == target_id for entry in busy):
                raise ValueError('Another operation on this file is running or uncertain. Inspect it before starting another change.')
            db.execute('UPDATE operations SET state=? WHERE id=?', ('running', ident))
        payload = json.loads(encoded)
        file = self.scoped(payload['file']['id'], allow_trash=payload['operation'] == 'restore')
        if self.fingerprint(file) != payload['fingerprint']:
            with self.db() as db:
                db.execute("UPDATE operations SET state='cancelled' WHERE id=?", (ident,))
            raise ValueError('File changed since preview. Ask for a new preview.')
        operation, backup, digest = payload['operation'], None, None
        if operation == 'replace':
            data = self.cached_bytes(payload['local_path'])
            digest = hashlib.sha256(data).hexdigest()
            if digest != payload['sha256']:
                with self.db() as db:
                    db.execute("UPDATE operations SET state='cancelled' WHERE id=?", (ident,))
                raise ValueError('Replacement bytes changed since preview.')
            backup = self.request('/files/' + file['id'] + '/copy?' + urllib.parse.urlencode({'fields': FIELDS}), 'POST', {'name': file['name'] + ' — archived before replacement ' + ident[:8], 'parents': file['parents'], 'appProperties': {'vistaReceiptId': None, 'vistaVariant': 'archive', 'chopperBackupFor': file['id'], 'chopperOperationId': ident}})
            self.scoped(backup['id'])
            if not file.get('md5Checksum') or backup.get('md5Checksum') != file.get('md5Checksum'):
                raise ValueError('Backup verification failed; original not overwritten.')
            if self.fingerprint(self.scoped(file['id'])) != payload['fingerprint']:
                raise ValueError('Source changed during backup. Original not overwritten; archived copy retained.')
            self.request('/files/' + file['id'] + '?uploadType=media', 'PATCH', data, raw=True, upload=True, mime=file['mimeType'])
            readback = self.request('/files/' + file['id'] + '?alt=media', raw=True)
            if hashlib.sha256(readback).hexdigest() != digest:
                raise ValueError('Replacement readback mismatch; archived copy retained. Reconcile before retrying.')
        else:
            if operation == 'trash' and file['mimeType'] == FOLDER and (self.listing(file['id'])['files'] or self.listing(file['id'], trashed=True)['files']):
                raise ValueError('Folder is no longer empty. Ask for a new preview.')
            self.request('/files/' + file['id'] + '?' + urllib.parse.urlencode({'fields': FIELDS}), 'PATCH', {'trashed': operation == 'trash'})
        final = self.scoped(file['id'], allow_trash=operation == 'trash')
        if operation != 'replace' and bool(final.get('trashed')) != (operation == 'trash'):
            raise ValueError('Google did not confirm the requested Trash state.')
        result = {'operation': operation, 'file': final, 'backup_file_id': backup['id'] if backup else None, 'sha256': digest, 'accounting': 'unchanged'}
        with self.db() as db:
            db.execute('UPDATE operations SET state=?,result=? WHERE id=?', ('drive_done', json.dumps(result), ident))
        return self.sync(ident, result)


def run(m, actor, args):
    client = Drive(m, actor)
    action = args['action']
    if action == 'status':
        root = client.scoped(client.root)
        return {'connection': 'direct Google Drive, not Vista proxy', 'folder': root, 'owner_only': True}
    if action == 'list':
        return client.listing(args.get('parent_id'), args.get('page_token'), bool(args.get('trashed')))
    if action == 'get':
        return {'file': client.scoped(args['file_id'], allow_trash=True)}
    if action == 'read':
        file = client.scoped(args['file_id'])
        if file['mimeType'].startswith('application/vnd.google-apps.'):
            raise ValueError('Use the document-specific editor/export tool for native Google files.')
        data = client.request('/files/' + file['id'] + '?alt=media', raw=True)
        directory = m.PROFILE / 'cache' / 'direct-drive'
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (file['id'] + '-' + Path(file['name']).name)
        path.write_bytes(data)
        return {'file': file, 'local_path': str(path)}
    if action == 'folder':
        parent = client.scoped(args.get('parent_id') or client.root)
        if parent['mimeType'] != FOLDER:
            raise ValueError('Destination must be a folder.')
        name = str(args['name']).strip()
        if not name or len(name) > 200:
            raise ValueError('Folder name must be 1–200 characters.')
        existing = [f for f in client.listing(parent['id'])['files'] if f['name'] == name and f['mimeType'] == FOLDER]
        file = existing[0] if existing else client.request('/files?' + urllib.parse.urlencode({'fields': FIELDS}), 'POST', {'name': name, 'parents': [parent['id']], 'mimeType': FOLDER})
        return {'file': client.scoped(file['id'])}
    if action == 'write':
        parent = client.scoped(args.get('parent_id') or client.root)
        if parent['mimeType'] != FOLDER:
            raise ValueError('Destination must be a folder.')
        name = str(args['name']).strip()
        mime = str(args.get('mime_type', 'text/plain'))
        if not name or len(name) > 200 or not re.fullmatch(r'[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+', mime) or mime.startswith('application/vnd.google-apps.'):
            raise ValueError('Use a valid regular-file name/MIME type; native Google documents need their editor.')
        data = client.cached_bytes(args['local_path']) if args.get('local_path') else str(args.get('text', '')).encode()
        if len(data) > LIMIT:
            raise ValueError('File exceeds 3 MB.')
        file = client.request('/files?' + urllib.parse.urlencode({'fields': FIELDS}), 'POST', {'name': name, 'parents': [parent['id']], 'mimeType': mime})
        client.request('/files/' + file['id'] + '?uploadType=media', 'PATCH', data, raw=True, upload=True, mime=mime)
        if client.request('/files/' + file['id'] + '?alt=media', raw=True) != data:
            raise ValueError('Upload readback mismatch. Inspect the created file before retrying.')
        return {'file': client.scoped(file['id']), 'stored': True}
    if action == 'edit':
        file = client.scoped(args['file_id'])
        if file['id'] == client.root:
            raise ValueError('Finances root cannot be moved or renamed.')
        fields = {k: args[k] for k in ('name', 'description') if k in args}
        query = {'fields': FIELDS}
        parent = args.get('parent_id')
        if parent:
            target = client.scoped(parent)
            if target['mimeType'] != FOLDER:
                raise ValueError('Destination must be a folder.')
            # Detect folder cycles before issuing Google mutation.
            queue, seen = [target], set()
            while queue and len(seen) < 100:
                item = queue.pop(0)
                if item['id'] == file['id']:
                    raise ValueError('Cannot move a folder inside itself.')
                if item['id'] in seen:
                    continue
                seen.add(item['id'])
                queue += [client.meta(p) for p in item.get('parents', [])]
            query.update(addParents=parent, removeParents=','.join(p for p in file.get('parents', []) if p != parent))
            if file.get('appProperties', {}).get('vistaReceiptId'):
                fields['appProperties'] = {**file['appProperties'], 'vistaFolderMode': 'manual'}
        if not fields and not parent:
            raise ValueError('Supply a name, description or destination.')
        client.request('/files/' + file['id'] + '?' + urllib.parse.urlencode(query), 'PATCH', fields)
        final = client.scoped(file['id'])
        if (parent and parent not in final.get('parents', [])) or ('name' in fields and final['name'] != fields['name']):
            raise ValueError('Move/rename readback did not match; inspect before retrying.')
        return {'file': final, 'links': 'same file ID; receipt links unchanged'}
    if action == 'preview':
        result = client.preview(args)
        if args.get('show_buttons', True):
            text = f"Review Drive {result['operation']} — NOT applied\n{result['file']['name']}\n{result['reason']}\n{result['note']}"
            ident = result['confirmation_id']
            req = urllib.request.Request('https://api.telegram.org/bot' + m._setting('TELEGRAM_BOT_TOKEN') + '/sendMessage', data=json.dumps({'chat_id': client.actor, 'text': text, 'reply_markup': {'inline_keyboard': [[{'text': 'Confirm ' + result['operation'], 'callback_data': 'dg:y:' + ident}], [{'text': 'Cancel', 'callback_data': 'dg:n:' + ident}]]}}).encode(), headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    if not json.load(response).get('ok'):
                        raise ValueError('Confirmation could not be delivered.')
            except Exception:
                raise ValueError('Drive preview saved, but confirmation delivery failed. Nothing changed.') from None
        return result
    if action == 'pending':
        with client.db() as db:
            rows = db.execute('SELECT id,state FROM operations WHERE actor=? AND state IN (\'running\',\'drive_done\')', (client.actor,)).fetchall()
        return {'operations': [{'id': id, 'state': state} for id, state in rows]}
    if action == 'sync':
        with client.db() as db:
            rows = db.execute('SELECT id,result FROM operations WHERE actor=? AND state=\'drive_done\'', (client.actor,)).fetchall()
        return {'results': [client.sync(id, json.loads(result)) for id, result in rows[:10]]}
    raise ValueError('Unsupported direct Drive action.')


async def callback(adapter, query, data, m):
    match = re.fullmatch(r'dg:([yn]):([a-f0-9]{32})', data)
    if not match:
        return False
    await query.answer()
    try:
        client = Drive(m, str(query.from_user.id))
        action, ident = match.groups()
        if action == 'n':
            with client.db() as db:
                count = db.execute('UPDATE operations SET state=\'cancelled\' WHERE id=? AND actor=? AND state=\'preview\'', (ident, client.actor)).rowcount
            if not count:
                raise ValueError('Cannot cancel an operation that already ran or belongs to another actor.')
            text = 'Cancelled. Drive files unchanged.'
        else:
            result = await asyncio.to_thread(client.confirm, ident)
            text = f"✅ Drive {result['operation']} completed: {result['file']['name']}\nVista sync: {result['vista_sync']}. Accounting unchanged."
            if result.get('backup_file_id'):
                text += '\nPrevious image archived in Finances.'
        await adapter._bot.send_message(chat_id=query.message.chat.id, text=text)
    except Exception as error:
        await adapter._bot.send_message(chat_id=query.message.chat.id, text='Drive action could not be fully confirmed. ' + str(error)[:350] + ' Check current state before retrying.')
    return True
