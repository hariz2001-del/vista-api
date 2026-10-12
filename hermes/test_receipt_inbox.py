import sys, unittest, types
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import receipt_inbox as inbox, receipt_form as form
class Tests(unittest.IsolatedAsyncioTestCase):
    def test_numbered_flags_and_order_controls_are_stable(self):
        text,rows=inbox.card({'listId':'42','total':1,'autoStash':True,'nextOffset':20,'entries':[{'number':1,'vendor':'Supplier','date':'2026-10-10','totalSen':1000,'ref':'R-111111','flags':['Existing Vista transactions — review linking']}]})
        self.assertIn('1. ⚠ Supplier',text);self.assertIn('Reply with a number',text)
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
        self.assertIn('No unconfigured receipts',notices[0]['text'])
    async def test_unrelated_number_does_not_consume_clarify_response(self):
        def call(*args):raise ValueError('no inbox list')
        event=types.SimpleNamespace(text='3',source=types.SimpleNamespace(user_id='456',chat_id='123'))
        self.assertFalse(await inbox.command(types.SimpleNamespace(),event,types.SimpleNamespace(_call=call)))
