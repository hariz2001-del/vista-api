import sys,unittest,types
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import receipt_maintenance as maintenance,receipt_form as form,vista_actor_guard as guard
RID='11111111-1111-4111-8111-111111111111'
class Tests(unittest.IsolatedAsyncioTestCase):
    def test_preview_buttons_are_confirmations_not_actions(self):
        text,rows=maintenance.preview_card('d',RID,{'confirmationId':'42','canonicalReceiptId':RID,'files':[{'name':'Duplicate photo'}]})
        self.assertIn('NOT deleted',text);self.assertIn('recoverable Trash',text)
        self.assertTrue(all(len(b['callback_data'])<=64 for row in rows for b in row))
        cron=lambda k:'1' if k=='HERMES_CRON_SESSION' else ''
        for tool in ('vista_edit_expense','vista_cleanup_receipt'):
            with self.assertRaises(PermissionError):guard.bind({'args':[guard.BRIDGE]},tool,{},cron)
    async def test_confirmation_uses_actual_actor_not_model_supplied_user(self):
        calls=[];notices=[]
        def call(method,path,body=None,user=None):calls.append((method,path,body,user));return {'saved':True}
        async def answer():pass
        async def send_message(**kw):notices.append(kw)
        q=types.SimpleNamespace(from_user=types.SimpleNamespace(id=456),message=types.SimpleNamespace(chat=types.SimpleNamespace(id=123)),answer=answer)
        a=types.SimpleNamespace(_bot=types.SimpleNamespace(send_message=send_message))
        await maintenance.callback(a,q,f'vm:e:{RID}:42',types.SimpleNamespace(_call=call))
        self.assertEqual(calls[0],('POST',f'/agent/expenses/{RID}/edit/confirm',{'confirmationId':'42'},'456'))
        self.assertIn('Expense corrected',notices[0]['text'])
