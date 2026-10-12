import copy
import asyncio
import hashlib
import json
import tempfile
import subprocess
import sys
import os
import io
import runpy
from contextlib import redirect_stdout
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse
import chopper_drive as drive
import vista_actor_guard as guard


class FakeDrive(drive.Drive):
    def __init__(self, bridge, actor='304348232'):
        super().__init__(bridge, actor)
        self.files = {
            'root-finances': {'id':'root-finances','name':'Finances','mimeType':drive.FOLDER,'parents':[]},
            'source-image': {'id':'source-image','name':'Receipt.jpg','mimeType':'image/jpeg','parents':['root-finances'],'version':'1','md5Checksum':'original','appProperties':{'vistaReceiptId':'receipt'}},
            'outside-file': {'id':'outside-file','name':'Private','mimeType':'image/jpeg','parents':[]},
            'shortcut-file': {'id':'shortcut-file','name':'Shortcut','mimeType':drive.SHORTCUT,'parents':['root-finances']},
        }
        self.bytes = {'source-image':b'\xff\xd8\xffold'}
        self.files['source-image']['md5Checksum'] = hashlib.md5(self.bytes['source-image']).hexdigest()
        self.writes=[]
        self.bad_backup=False

    def request(self, path, method='GET', body=None, raw=False, upload=False, mime=None):
        target = urlparse(path).path.split('/')[2] if path.startswith('/files/') else None
        if method == 'GET':
            if target is None:
                return {'files':[]}
            if raw:
                return self.bytes[target]
            return copy.deepcopy(self.files[target])
        self.writes.append((method,path,body))
        if '/copy?' in path:
            backup = {**self.files[target],**body,'id':'backup-image','md5Checksum':'bad' if self.bad_backup else self.files[target]['md5Checksum']}
            self.files['backup-image']=backup
            self.bytes['backup-image']=self.bytes[target]
            return copy.deepcopy(backup)
        if raw:
            self.bytes[target]=body
            self.files[target]['md5Checksum']=hashlib.md5(body).hexdigest()
        else:
            self.files[target].update(body)
        self.files[target]['version']='2'
        return copy.deepcopy(self.files[target])


class DirectDriveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.profile=Path(self.temp.name)
        (self.profile/'cache').mkdir()
        self.image=self.profile/'cache'/'new.jpg'
        self.image.write_bytes(b'\xff\xd8\xffnew')
        self.bridge=types.SimpleNamespace(PROFILE=self.profile,_setting=lambda name, default='': {'DRIVE_FINANCES_FOLDER_ID':'root-finances'}.get(name,default),_call=lambda *a,**kw: {'receiptIds':['receipt']})
        self.client=FakeDrive(self.bridge)

    def tearDown(self):
        self.temp.cleanup()

    def preview(self, operation='replace', **kwargs):
        return self.client.preview({'operation':operation,'file_id':'source-image','local_path':str(self.image),'reason':'Owner requested clearer photo of same paper',**kwargs})['confirmation_id']

    def test_scopes_actor_shortcut_and_root_are_enforced(self):
        with self.assertRaises(PermissionError):FakeDrive(self.bridge,'partner')
        for id in ['outside-file','shortcut-file']:
            with self.assertRaises(ValueError):self.client.scoped(id)
        with self.assertRaises(ValueError):self.preview('trash',file_id='root-finances')
        self.assertEqual(self.client.writes,[])

    def test_preview_never_writes_and_confirm_preserves_id_with_backup(self):
        ident=self.preview()
        self.assertEqual(self.client.writes,[])
        result=self.client.confirm(ident)
        self.assertEqual(result['file']['id'],'source-image')
        self.assertEqual(result['backup_file_id'],'backup-image')
        self.assertEqual(self.client.bytes['backup-image'],b'\xff\xd8\xffold')
        self.assertEqual(self.client.bytes['source-image'],b'\xff\xd8\xffnew')
        count=len(self.client.writes)
        self.assertTrue(self.client.confirm(ident)['already_completed'])
        self.assertEqual(len(self.client.writes),count)

    def test_sync_failure_does_not_repeat_drive_mutation(self):
        self.bridge._call=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError('Vista offline'))
        ident=self.preview()
        self.assertEqual(self.client.confirm(ident)['vista_sync'],'pending')
        count=len(self.client.writes)
        self.bridge._call=lambda *a,**kw: {'receiptIds':['receipt']}
        self.assertEqual(self.client.confirm(ident)['vista_sync'],'synced')
        self.assertEqual(len(self.client.writes),count)

    def test_backup_failure_never_overwrites_source(self):
        self.client.bad_backup=True
        with self.assertRaisesRegex(ValueError,'Backup verification'):self.client.confirm(self.preview())
        self.assertEqual(self.client.bytes['source-image'],b'\xff\xd8\xffold')

    def test_stale_confirmation_and_changed_source_bytes_are_rejected(self):
        ident=self.preview()
        self.client.files['source-image']['version']='2'
        with self.assertRaisesRegex(ValueError,'changed since'):self.client.confirm(ident)
        self.assertEqual(self.client.writes,[])
        self.client.files['source-image']['version']='1'
        ident=self.preview()
        self.image.write_bytes(b'\xff\xd8\xffdifferent')
        with self.assertRaisesRegex(ValueError,'bytes changed'):self.client.confirm(ident)
        self.assertEqual(self.client.writes,[])

    def test_trash_and_restore_keep_file_id_and_readback(self):
        self.assertTrue(self.client.confirm(self.preview('trash'))['file']['trashed'])
        self.assertFalse(self.client.confirm(self.preview('restore'))['file']['trashed'])

    def test_unsafe_paths_and_mismatched_format_rejected(self):
        with self.assertRaises(ValueError):self.preview(local_path=str(self.profile/'secret.env'))
        self.image.write_bytes(b'not a jpeg')
        with self.assertRaisesRegex(ValueError,'same real'):self.preview()

    def test_expired_and_other_actor_confirmations_rejected(self):
        ident=self.preview()
        with self.client.db() as db:db.execute('UPDATE operations SET made=0 WHERE id=?',(ident,))
        with self.assertRaisesRegex(ValueError,'expired'):self.client.confirm(ident)
        ident=self.preview()
        with self.client.db() as db:db.execute('UPDATE operations SET actor=? WHERE id=?',('other',ident))
        with self.assertRaises(PermissionError):self.client.confirm(ident)

    def test_worker_can_only_sync_and_model_cannot_confirm(self):
        config={'args':[guard.BRIDGE]}
        session=lambda k: {'HERMES_CRON_SESSION':'1'}.get(k)
        self.assertEqual(guard.bind(config,'chopper_drive',{'action':'sync'},session)['telegram_user_id'],'304348232')
        for action in ['edit','preview','read','confirm']:
            with self.assertRaises(PermissionError):guard.bind(config,'chopper_drive',{'action':action},session)
        with patch.object(drive,'Drive',return_value=self.client):
            with self.assertRaisesRegex(ValueError,'Unsupported'):drive.run(self.bridge,'304348232',{'action':'confirm'})

    def test_direct_reads_work_when_vista_is_offline(self):
        self.bridge._call=lambda *a,**kw: (_ for _ in ()).throw(RuntimeError('Vista offline'))
        with patch.object(drive,'Drive',return_value=self.client):
            result=drive.run(self.bridge,'304348232',{'action':'status'})
        self.assertIn('direct Google Drive',result['connection'])

    def test_transport_prevents_owner_impersonation_for_direct_drive(self):
        config={'args':[guard.BRIDGE]}
        session=lambda k: {'HERMES_SESSION_PLATFORM':'telegram','HERMES_SESSION_USER_ID':'partner'}.get(k)
        with self.assertRaises(PermissionError):guard.bind(config,'chopper_drive',{'action':'edit','telegram_user_id':'304348232'},session)
        self.assertEqual(guard.bind(config,'chopper_drive',{'action':'status'},session)['telegram_user_id'],'partner')

    def test_native_confirmation_rechecks_actual_actor_and_cancel_is_durable(self):
        notices=[]
        async def answer():pass
        async def send_message(**kw):notices.append(kw['text'])
        adapter=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        query=types.SimpleNamespace(from_user=types.SimpleNamespace(id='partner'),message=types.SimpleNamespace(chat=types.SimpleNamespace(id=123)),answer=answer)
        ident=self.preview()
        def client(m,actor):
            if actor=='304348232':return self.client
            return FakeDrive(m,actor)
        with patch.object(drive,'Drive',side_effect=client):
            asyncio.run(drive.callback(adapter,query,'dg:y:'+ident,self.bridge))
            self.assertEqual(self.client.writes,[])
            query.from_user.id='304348232'
            asyncio.run(drive.callback(adapter,query,'dg:n:'+ident,self.bridge))
        self.assertIn('Cancelled',notices[-1])
        with self.assertRaisesRegex(ValueError,'cancelled'):self.client.confirm(ident)
        self.assertLessEqual(len('dg:y:'+ident),64)

    def test_two_confirmations_cannot_overwrite_same_file_concurrently(self):
        first=self.preview();second=self.preview()
        with self.client.db() as db:db.execute("UPDATE operations SET state='running' WHERE id=?",(first,))
        with self.assertRaisesRegex(ValueError,'Another operation'):self.client.confirm(second)
        self.assertEqual(self.client.writes,[])

    def test_awaiting_photo_is_owner_bound_durable_single_use_and_caption_overrides(self):
        with patch.object(drive,'Drive',return_value=self.client):
            drive.run(self.bridge,'304348232',{'action':'await_image','file_id':'source-image','reason':'Clearer same receipt'})
            intent=drive.photo_intent(self.bridge,'304348232')
            self.assertEqual(intent['target_file_id'],'source-image')
            self.assertIsNone(drive.photo_intent(self.bridge,'304348232'))
            drive.run(self.bridge,'304348232',{'action':'await_image','file_id':'source-image','reason':'Same paper'})
            self.assertEqual(drive.photo_intent(self.bridge,'304348232','replace R-ABCDEF')['caption'],'replace R-ABCDEF')
        self.assertEqual(self.client.writes,[])

    def test_expired_photo_wait_cannot_capture_a_later_receipt(self):
        with patch.object(drive,'Drive',return_value=self.client):
            drive.run(self.bridge,'304348232',{'action':'await_image','file_id':'source-image','reason':'Same paper'})
            with self.client.db() as db:db.execute('UPDATE awaiting_images SET made=0')
            self.assertIsNone(drive.photo_intent(self.bridge,'304348232'))
            drive.run(self.bridge,'304348232',{'action':'await_image','file_id':'source-image','reason':'Same paper'})
            drive.run(self.bridge,'304348232',{'action':'cancel_image'})
            self.assertIsNone(drive.photo_intent(self.bridge,'304348232'))

    def test_separate_mcp_exposes_only_drive_and_rejects_database_calls(self):
        root=Path(__file__).resolve().parent
        messages=[{'jsonrpc':'2.0','id':1,'method':'tools/list'}, {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'vista_post','arguments':{}}}]
        proc=subprocess.run([sys.executable,str(root/'drive_mcp.py')],input='\n'.join(json.dumps(x) for x in messages)+'\n',capture_output=True,text=True,encoding='utf-8',env={**os.environ,'PYTHONUTF8':'1'},check=True)
        replies=[json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual([t['name'] for t in replies[0]['result']['tools']],['chopper_drive'])
        self.assertTrue(replies[1]['result']['isError'])
        proc=subprocess.run([sys.executable,str(root/'vista_mcp.py')],input=json.dumps(messages[0])+'\n',capture_output=True,text=True,encoding='utf-8',env={**os.environ,'PYTHONUTF8':'1'},check=True)
        self.assertNotIn('chopper_drive',[t['name'] for t in json.loads(proc.stdout)['result']['tools']])

    def test_separate_mcp_transport_binds_actor_and_worker_permissions(self):
        config={'args':[guard.DRIVE_BRIDGE]}
        session=lambda k: {'HERMES_SESSION_PLATFORM':'telegram','HERMES_SESSION_USER_ID':'partner'}.get(k)
        with self.assertRaises(PermissionError):guard.bind(config,'chopper_drive',{'action':'edit','telegram_user_id':'304348232'},session)
        session=lambda k: {'HERMES_CRON_SESSION':'1'}.get(k)
        with self.assertRaises(PermissionError):guard.bind(config,'chopper_drive',{'action':'preview'},session)
        self.assertEqual(guard.bind(config,'chopper_drive',{'action':'sync'},session)['telegram_user_id'],'304348232')

    def test_monitor_wakes_for_pending_sync_when_ocr_queue_is_empty(self):
        integrations=self.profile/'integrations';integrations.mkdir()
        (integrations/'vista_mcp.py').write_text("def _setting(name): return '304348232'\ndef _call(*a,**kw): return {'jobs': []}\n")
        with self.client.db() as db:
            db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)',('pending-test','304348232',0,'drive_done','{}','{}'))
        real_path=Path
        factory=lambda value: self.profile if str(value)=='/home/ubuntu/.hermes/profiles/sarangbooks' else real_path(value)
        output=io.StringIO()
        with patch('pathlib.Path',side_effect=factory),redirect_stdout(output):
            runpy.run_path(str(real_path(__file__).resolve().parent/'receipt-queue-monitor.py'))
        result=json.loads(output.getvalue())
        self.assertEqual(result['eligible'],[])
        self.assertEqual(result['pendingDriveSync'],['pending-test'])


if __name__=='__main__':unittest.main()
