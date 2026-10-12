"""Idempotent, minimal mechanical hook installer; preserves upstream backup."""
from pathlib import Path
import shutil

target = Path('/home/ubuntu/.hermes/hermes-agent/plugins/platforms/telegram/adapter.py')
text = target.read_text()
module = '/home/ubuntu/.hermes/profiles/sarangbooks/integrations/telegram_receipts.py'
loader = f"""import importlib.util
        _vista_spec = importlib.util.spec_from_file_location('vista_telegram_receipts', '{module}')
        _vista_receipts = importlib.util.module_from_spec(_vista_spec)
        _vista_spec.loader.exec_module(_vista_receipts)"""
photo_anchor = '                await self._route_photo_event(msg, event)\n                return\n'
callback_anchor = '        cb = self._callback_ctx(query)\n        # Model picker / generic choice picker'
if 'VISTA_RECEIPT_PHOTO_V1' not in text:
    if text.count(photo_anchor) != 1 or callback_anchor not in text: raise SystemExit('Upstream anchors changed; inspect instead of guessing.')
    backup = target.with_suffix('.py.before-vista-receipts')
    if not backup.exists(): shutil.copy2(target, backup)
    photo_hook = '                # VISTA_RECEIPT_PHOTO_V1 (Sarang-only; no other bot behaviour changes)\n                ' + loader.replace('\n        ', '\n                ') + '\n                if await _vista_receipts.photo(self, msg, event, bytes(image_bytes)):\n                    return\n'
    text = text.replace(photo_anchor, photo_hook + photo_anchor)
    callback_hook = "        # VISTA_RECEIPT_CALLBACK_V1\n        if data.startswith('vr:'):\n            if not await self._callback_authorized(query, cb, _unauthorized()):\n                return\n            " + loader.replace('\n        ', '\n            ') + '\n            if await _vista_receipts.callback(self, query, data):\n                return\n'
    text = text.replace(callback_anchor, '        cb = self._callback_ctx(query)\n' + callback_hook + '        # Model picker / generic choice picker')
    compile(text, str(target), 'exec')
    target.write_text(text)
if 'VISTA_RECEIPT_DOCUMENT_V1' not in text:
    document_anchor = '                await self._route_photo_event(msg, event)\n                return True\n'
    if text.count(document_anchor) != 1: raise SystemExit('Image-document anchor changed; inspect first.')
    document_hook = '                # VISTA_RECEIPT_DOCUMENT_V1\n                ' + loader.replace('\n        ', '\n                ') + '\n                if await _vista_receipts.photo(self, msg, event, bytes(image_bytes)):\n                    return True\n'
    text = text.replace(document_anchor, document_hook + document_anchor)
    compile(text, str(target), 'exec')
    target.write_text(text)
if 'VISTA_NAMED_CHOICES_V1' not in text:
    choice_anchor = '                rows = [[InlineKeyboardButton(str(idx + 1), callback_data=f"cl:{clarify_id}:{idx}")] for idx in range(len(choices))]'
    if choice_anchor not in text: raise SystemExit('Clarify button anchor changed; inspect first.')
    named = '                # VISTA_NAMED_CHOICES_V1: finance menus use real labels, other bots unchanged\n                _vista_named = str(getattr(self, "_update_receipt_dir", "")) == "/home/ubuntu/.hermes/profiles/sarangbooks"\n                rows = [[InlineKeyboardButton(str(choices[idx])[:60] if _vista_named else str(idx + 1), callback_data=f"cl:{clarify_id}:{idx}")] for idx in range(len(choices))]'
    text = text.replace(choice_anchor, named)
    compile(text, str(target), 'exec')
    target.write_text(text)
if 'VISTA_BUSINESS_CONTEXT_V1' not in text:
    context_anchor = '    async def handle_message(self, event: MessageEvent) -> None:\n        self._accept_update()\n        await super().handle_message(event)'
    if context_anchor not in text: raise SystemExit('Message context anchor changed; inspect first.')
    hook = '    async def handle_message(self, event: MessageEvent) -> None:\n        self._accept_update()\n        # VISTA_BUSINESS_CONTEXT_V1\n        ' + loader + '\n        event = _vista_receipts.business_context(self, event)\n        await super().handle_message(event)'
    text = text.replace(context_anchor, hook)
    compile(text, str(target), 'exec')
    target.write_text(text)
print('Receipt hooks and business capability context installed; non-Sarang bots unchanged.')
