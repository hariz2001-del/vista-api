"""Deterministic Sarang-only photo buttons. Uses PTB's authenticated gateway.

No second poller, no bot token copy, no process-local callback state. The receipt
UUID in each button survives gateway restarts; Vista rechecks the real sender.
"""
import asyncio
import base64
import dataclasses
import importlib.util
import re
from pathlib import Path

HOME = Path('/home/ubuntu/.hermes/profiles/sarangbooks')

def enabled(adapter):
    return Path(str(getattr(adapter, '_update_receipt_dir', ''))) == HOME

def bridge():
    spec = importlib.util.spec_from_file_location('sarang_receipt_bridge', HOME / 'integrations/vista_mcp.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

async def photo(adapter, message, event, data):
    if not enabled(adapter): return False
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    m = bridge()
    try:
        document = getattr(message, 'document', None)
        mime = getattr(document, 'mime_type', None) or 'image/jpeg'
        result = await asyncio.to_thread(m._call, 'POST', '/agent/receipts', {
            'imageBase64': base64.b64encode(data).decode(), 'mimeType': mime.lower(),
            'telegramChatId': str(message.chat.id), 'telegramMessageId': str(message.message_id),
            'deferProcessing': True,
        }, str(message.from_user.id))
        receipt = result['receipt']; rid = receipt['id']
        warning = ''
        if result.get('duplicate'):
            amount = sum(row['amountSen'] for row in receipt.get('expenses', [])) / 100
            warning = f"Already saved: {result.get('duplicateReason', 'same receipt')}. Existing entries RM {amount:.2f}. You can add a brand allocation or link existing expenses; I will not duplicate the purchase.\n"
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton('Key in', callback_data=f'vr:{rid}:key'), InlineKeyboardButton('Stash for later', callback_data=f'vr:{rid}:stash')],
            [InlineKeyboardButton('Edit reading', callback_data=f'vr:{rid}:edit'), InlineKeyboardButton('View scan', callback_data=f'vr:{rid}:scan')],
        ])
        kwargs = {'chat_id': message.chat.id, 'text': f"{warning}{receipt['ref']} saved safely. What would you like to do? Reading/scan can continue in the background.", 'reply_markup': keyboard}
        if message.message_thread_id: kwargs['message_thread_id'] = message.message_thread_id
        await adapter._bot.send_message(**kwargs)
        # Caption requests still reach Hermes with the durable receipt reference.
        if message.caption:
            event.text = f"Receipt already saved as {rid}. {message.caption}. Do not upload it again or post without confirmation."
            await adapter.handle_message(event)
        return True
    except Exception:
        # Do not swallow receipt failures or emit secrets/provider payloads.
        await adapter._bot.send_message(chat_id=message.chat.id, text='The automatic receipt menu could not be saved. I am passing the photo to Hermes to retry; no expense has been posted.')
        return False

async def callback(adapter, query, data):
    if not enabled(adapter): return False
    match = re.fullmatch(r'vr:([a-f0-9-]{36}):(key|stash|edit|scan)', data)
    if not match: return False
    rid, action = match.groups(); user = str(query.from_user.id)
    m = bridge()
    try:
        # Revalidate backend role before accepting a stale/shared button.
        receipt = await asyncio.to_thread(m._call, 'GET', f'/agent/receipts/{rid}', None, user)
        if action == 'stash':
            status = receipt['receipt']['status']
            if status in ('POSTED', 'LINKED', 'REJECTED'):
                await query.answer('Already processed. Use Key in to review existing allocations.', show_alert=True)
                return True
            await asyncio.to_thread(m._call, 'POST', f'/agent/receipts/{rid}/skip', {'reason': 'Stashed from Telegram button'}, user)
            await query.answer('Stashed; no expense posted.')
            return True
        await query.answer()
        if action == 'scan':
            result = await asyncio.to_thread(m._run, 'vista_get_receipt', {'receipt_id': rid, 'with_image': True, 'telegram_user_id': user})
            path = result['receipt'].get('image_path')
            if path:
                with open(path, 'rb') as stream:
                    await adapter._bot.send_photo(chat_id=query.message.chat.id, photo=stream, caption='Receipt scan' if result['receipt'].get('hasScan') else 'Original photo; scan is still pending.')
                return True
        from gateway.platforms.base import MessageType
        event = adapter._build_message_event(query.message, MessageType.TEXT)
        event.source = dataclasses.replace(event.source, user_id=user, user_name=query.from_user.full_name, is_bot=False)
        event.text = f"{ {'key': 'Key in this receipt; first show existing entries and duplicate/matching reasons, then ask live Vista category and brand buttons.', 'edit': 'Edit this receipt reading using buttons; retrieve original and read it if still pending.', 'scan': 'Make and show the receipt scan.'}[action]} Receipt UUID {rid}. The authenticated Telegram sender is {user}. Receipt already saved; do not upload again. Never post/link without my confirmation."
        event.message_id = f'vista-callback-{query.id}'
        await adapter.handle_message(event)
        return True
    except Exception:
        await query.answer('Could not complete this action. Nothing was posted; please retry or ask Hermes.', show_alert=True)
        return True
