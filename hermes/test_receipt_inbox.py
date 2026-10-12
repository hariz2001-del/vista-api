import sys, unittest, types
from unittest.mock import patch,mock_open
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import receipt_inbox as inbox, receipt_form as form
class Tests(unittest.IsolatedAsyncioTestCase):
    def test_numbered_flags_and_order_controls_are_stable(self):
        text,rows=inbox.card({'listId':'42','total':1,'autoStash':True,'nextOffset':20,'entries':[{'number':1,'vendor':'Supplier','date':'2026-10-10','totalSen':1000,'ref':'R-111111','flags':['Existing Vista transactions — review linking']}]})
        self.assertEqual(text,'1. R-111111 — Supplier · 10/10/2026 · RM 10.00')
        self.assertNotIn('Existing Vista',text)
        labels=[b['text'] for row in rows for b in row]
        self.assertIn('Flags first',labels);self.assertIn('Other receipts first',labels);self.assertIn('Next page',labels)
        self.assertEqual(rows[0][0]['callback_data'],'vi:select:42:1')
        self.assertTrue(all(len(b['callback_data'])<=64 for row in rows for b in row))
    async def test_stop_mode_beats_auto_stash_substring(self):
        calls=[];notices=[]
        def call(method,path,body=None,user=None):
            calls.append((method,path,body,user))
            if path.endswith('/review'):return {'listId':'1','total':0,'entries':[],'autoStash':False}
            return {'autoStash':False}
        async def send_message(**kw):notices.append(kw)
        a=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        event=types.SimpleNamespace(text='stop auto stash',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        old=form.markup;form.markup=lambda x:x
        try:self.assertTrue(await inbox.command(a,event,types.SimpleNamespace(_call=call)))
        finally:form.markup=old
        self.assertEqual(calls[0][2],{'autoStash':False});self.assertTrue(all(c[3]=='456' for c in calls))
        self.assertIn('No receipts in this list.',notices[0]['text'])
    async def test_unrelated_number_does_not_consume_clarify_response(self):
        def call(*args):raise ValueError('no inbox list')
        event=types.SimpleNamespace(text='3',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        self.assertFalse(await inbox.command(types.SimpleNamespace(),event,types.SimpleNamespace(_call=call)))
    async def test_bulk_and_endbulk_commands_use_native_state_not_model(self):
        calls=[];notices=[]
        def call(method,path,body=None,user=None):calls.append((method,path,body,user));return {}
        async def send_message(**kw):notices.append(kw)
        a=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message));m=types.SimpleNamespace(_call=call,_bulk_notify=lambda user:{'pending':2,'sent':False})
        event=types.SimpleNamespace(text='/bulk@chopper67bot',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        self.assertTrue(await inbox.command(a,event,m));self.assertEqual(calls[0][1],'/agent/inbox/bulk/start')
        event.text='/endbulk';self.assertTrue(await inbox.command(a,event,m))
        self.assertEqual(calls[-1][1],'/agent/inbox/bulk/end');self.assertIn('automatically',notices[-1]['text'])
        self.assertTrue(all(c[3]=='456' for c in calls))
    def test_standard_receipt_list_and_manual_controls(self):
        text,rows=inbox.card({'listId':'42','listScope':'batch','entries':[{'number':21,'ref':'R-5AE50F','vendor':'BWY Holdings','date':'2026-10-09','totalSen':3520,'flags':[]}]})
        self.assertEqual(text,'21. R-5AE50F — BWY Holdings · 09/10/2026 · RM 35.20')
        self.assertNotIn('⚠',text)
        self.assertEqual([b['text'] for row in inbox.action_menu('x') for b in row],['Categorise','Stash for later','Edit receipt','View scan','Split receipt'])
        self.assertEqual([b['text'] for row in inbox.progress('x') for b in row],['Next receipt','End','Choose custom receipt'])
    async def test_number_selection_sends_stored_photo_and_initial_menu_not_inner_form(self):
        from test_receipt_form import fixture
        v=fixture();calls=[];sent=[]
        def call(method,path,body=None,user=None):calls.append((method,path,body,user));return {'receiptId':v['receipt']['id'],'form':v}
        def run(name,args):calls.append((name,args));return {'receipt':{'ref':'R-111111','vendor':'Supplier','receiptDate':'2026-10-10','image_path':'/trusted/cache/receipt.jpg'}}
        async def photo(**kw):sent.append(('photo',kw['photo'].read()))
        async def message(**kw):sent.append(('message',kw))
        a=types.SimpleNamespace(_bot=types.SimpleNamespace(send_photo=photo,send_message=message))
        q=types.SimpleNamespace(message=types.SimpleNamespace(chat=types.SimpleNamespace(id='123')))
        old=form.markup;form.markup=lambda x:x
        try:
            with patch('receipt_inbox.open',mock_open(read_data=b'actual-stored-scan'),create=True):await inbox.open_selection(a,q,types.SimpleNamespace(_call=call,_run=run),'456',21,'42')
        finally:form.markup=old
        self.assertEqual(sent[0],('photo',b'actual-stored-scan'))
        self.assertEqual([b['text'] for row in sent[1][1]['reply_markup'] for b in row],['Categorise','Stash for later','Edit receipt','View scan','Split receipt'])
        self.assertEqual(calls[0][2],{'number':21,'listId':'42'});self.assertEqual(calls[0][3],'456')
    def test_last_worker_finish_delivers_closed_batch_without_per_photo_menu(self):
        import importlib.util,io,json
        spec=importlib.util.spec_from_file_location('bulk_bridge_test',Path(__file__).resolve().parent/'vista_mcp.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        calls=[];sent=[]
        def call(method,path,body=None,user=None):
            calls.append((method,path,body,user))
            if '/finish' in path:return {'saved':True,'receiptId':'receipt'}
            if path.endswith('/ready'):return {'delivery':{'id':'42','leaseToken':'lease','chatId':'789','result':{'listId':'43','total':1,'listScope':'batch','entries':[{'number':1,'ref':'R-111111','vendor':'Supplier','date':'2026-10-09','totalSen':1000,'flags':[]}]}}}
            return {'saved':True}
        def send(req,timeout=30):sent.append(json.loads(req.data));return io.BytesIO(json.dumps({'ok':True,'result':{'message_id':99}}).encode())
        m._call=call;m._dotenv=lambda:{'TELEGRAM_BOT_TOKEN':'test-only'}
        with patch.object(m.urllib.request,'urlopen',send):result=m._run('vista_receipt_queue',{'action':'finish','job_id':'job','lease_token':'lease','telegram_user_id':'456'})
        self.assertTrue(result['bulkNotification']['sent'])
        self.assertEqual(sent[0]['chat_id'],'789') # Destination from stored backend batch, not model.
        self.assertEqual(sent[0]['text'],'1. R-111111 — Supplier · 09/10/2026 · RM 10.00')
        self.assertEqual(calls[-1][1],'/agent/inbox/bulk/delivered')
