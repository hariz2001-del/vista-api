"""No-token transport contract tests for immediate menus and callback identity."""
import asyncio
import dataclasses
import importlib.util
import sys
import types
import unittest
from pathlib import Path

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('receipts', root/'telegram_receipts.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
telegram = types.ModuleType('telegram')
telegram.InlineKeyboardButton = lambda text, callback_data: {'text': text, 'callback_data': callback_data}
telegram.InlineKeyboardMarkup = lambda rows: rows
sys.modules['telegram'] = telegram
base = types.ModuleType('gateway.platforms.base'); base.MessageType = types.SimpleNamespace(TEXT='text')
sys.modules['gateway.platforms.base'] = base
@dataclasses.dataclass
class Source:
    user_id: str = 'bot'
    user_name: str = 'bot'
    is_bot: bool = True
class Adapter:
    _update_receipt_dir = m.HOME
    def __init__(self): self.sent=[]; self.events=[]; self._bot=self
    async def send_message(self, **kw): self.sent.append(kw)
    async def handle_message(self, event): self.events.append(event)
    def _build_message_event(self, message, kind): return types.SimpleNamespace(source=Source(), text='', message_id='')
class Bridge:
    def __init__(self, duplicate=False): self.calls=[]; self.duplicate=duplicate
    def _call(self, method, path, body=None, user=None):
        self.calls.append((method,path,body,user))
        return {'duplicate':self.duplicate, 'duplicateReason':'identical image bytes', 'receipt':{'id':'11111111-1111-4111-8111-111111111111','ref':'R-111111','status':'UPLOADED','expenses':[]}}
class ReceiptTests(unittest.IsolatedAsyncioTestCase):
    async def test_business_questions_get_current_capabilities_without_erasing_context(self):
        a=Adapter(); event=types.SimpleNamespace(channel_prompt='Existing context')
        result=m.business_context(a,event)
        self.assertIn('Existing context',result.channel_prompt)
        self.assertIn('vista_operations',result.channel_prompt)
        self.assertIn('/agent/team/staff',result.channel_prompt)
        self.assertIn('not finance-only',result.channel_prompt)
        a._update_receipt_dir=Path('/other-profile'); event=types.SimpleNamespace(channel_prompt='Other bot')
        self.assertEqual(m.business_context(a,event).channel_prompt,'Other bot')
    async def test_photo_menu_is_immediate_and_durable_without_model_turn(self):
        a=Adapter(); b=Bridge(); m.bridge=lambda:b
        msg=types.SimpleNamespace(chat=types.SimpleNamespace(id=123),from_user=types.SimpleNamespace(id=456),message_id=9,message_thread_id=None,caption=None)
        self.assertTrue(await m.photo(a,msg,types.SimpleNamespace(),b'photo'))
        self.assertEqual(len(a.sent),1); self.assertEqual(a.events,[])
        self.assertEqual([x['text'] for row in a.sent[0]['reply_markup'] for x in row],['Key in','Stash for later','Edit reading','View scan'])
        self.assertTrue(b.calls[0][2]['deferProcessing']); self.assertEqual(b.calls[0][3],'456')
    async def test_duplicate_still_gets_menu_and_reason(self):
        a=Adapter(); b=Bridge(True); m.bridge=lambda:b
        msg=types.SimpleNamespace(chat=types.SimpleNamespace(id=123),from_user=types.SimpleNamespace(id=456),message_id=9,message_thread_id=None,caption=None)
        await m.photo(a,msg,types.SimpleNamespace(),b'photo')
        self.assertIn('identical image bytes',a.sent[0]['text']); self.assertEqual(len(a.sent[0]['reply_markup']),2)
    async def test_other_bots_are_untouched(self):
        a=Adapter(); a._update_receipt_dir=Path('/other-profile')
        self.assertFalse(await m.photo(a,None,None,b'photo')); self.assertEqual(a.sent,[])
    async def test_image_document_menu_preserves_image_mime(self):
        a=Adapter(); b=Bridge(); m.bridge=lambda:b
        msg=types.SimpleNamespace(chat=types.SimpleNamespace(id=123),from_user=types.SimpleNamespace(id=456),message_id=10,message_thread_id=None,caption=None,document=types.SimpleNamespace(mime_type='image/png'))
        self.assertTrue(await m.photo(a,msg,types.SimpleNamespace(),b'png'))
        self.assertEqual(b.calls[0][2]['mimeType'],'image/png')
    async def test_callback_preserves_sender_identity_and_enters_receipt_flow(self):
        a=Adapter(); b=Bridge(); m.bridge=lambda:b
        async def answer(*args,**kwargs): pass
        q=types.SimpleNamespace(from_user=types.SimpleNamespace(id=456,full_name='Owner'),message=types.SimpleNamespace(),id='callback',answer=answer)
        self.assertTrue(await m.callback(a,q,'vr:11111111-1111-4111-8111-111111111111:key'))
        self.assertEqual(a.events[0].source.user_id,'456'); self.assertFalse(a.events[0].source.is_bot)
        self.assertIn('Receipt UUID',a.events[0].text)
if __name__=='__main__': unittest.main()
