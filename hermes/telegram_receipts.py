"""Deterministic Sarang-only photo buttons. Uses PTB's authenticated gateway.

No second poller, no bot token copy, no process-local callback state. The receipt
UUID in each button survives gateway restarts; Vista rechecks the real sender.
"""
import asyncio
import base64
import dataclasses
import importlib.util
import re
import sys
from pathlib import Path

HOME = Path('/home/ubuntu/.hermes/profiles/sarangbooks')

def form_module():
    folder = str(Path(__file__).resolve().parent)
    if folder not in sys.path: sys.path.insert(0, folder)
    import receipt_form
    return receipt_form

def business_context(adapter, event):
    """Refresh capabilities on actual Telegram turns, preserving old chat history."""
    if not enabled(adapter): return event
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone(timedelta(hours=8)))
    context = (
        f'LIVE CLOCK AT MESSAGE HANDLING: {now.isoformat(timespec="seconds")} '
        f'({now.strftime("%A")}, Asia/Kuala_Lumpur, UTC+08:00). '
        'This timestamp is a snapshot, not a continuously updating clock. For current time, '
        'today/yesterday sales, or who works right now, call vista_current_time or vista_sales_today. '
        'Never take the current date from old messages. For sales today use vista_sales_today '
        'rather than vista_sales with omitted dates (which is a seven-day report). Show the '
        'actual sales date and as-of time; explain any overnight trading-day cutoff. '
        'CURRENT BUSINESS CAPABILITIES: '
        'Your name is Chopper, the Sarang business operations assistant, not finance-only. '
        'Never call yourself Sarang Books or Sarang Bookkeeper. '
        'Earlier assistant statements denying staff, roster, stock or addon access are obsolete. '
        'For staff names, call vista_operations(method=GET,path=/agent/team/staff). '
        'For who is working now/today/tomorrow, discover roster weeks using vista_operations '
        'GET /agent/team/weeks, then retrieve the published week export /agent/team/weeks/{id}/export. '
        'Account for overnight shifts and Malaysia time; roster is not proof of attendance. '
        'Stock counts/sheets, coverage, attendance and payroll are in vista_operations; '
        'business menu/order/ledger records in vista_business_data; product addons by day in '
        'vista_item_sales; ingredient cost in vista_recipe_cost (ask for missing real inputs). '
        'For a supported read-only question, actually try the appropriate tool before saying '
        'you cannot access data. If a tool fails, explain its real error; never invent results. '
        'Forward only this event actual sender ID and respect backend role denials. '
        'No financial posting or business mutation is authorised by a read-only question.'
    )
    event.channel_prompt = '\n\n'.join(x for x in [getattr(event, 'channel_prompt', '') or '', context] if x)
    # Hermes' supported auto-skill path avoids a separate model/tool round trip.
    event.auto_skill = 'sarang-bookkeeping'
    return event

def enabled(adapter):
    return Path(str(getattr(adapter, '_update_receipt_dir', ''))) == HOME

def menu_commands(adapter,commands):
    if not enabled(adapter):return commands
    return [('bulk','Silently scan and store a receipt batch'),('endbulk','Finish batch and list scanned receipts')]+[row for row in commands if row[0] not in ('bulk','endbulk')]

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
        if result.get('bulk'):return True # Silent intake; durable worker does OCR/colour scan/Drive.
        if result.get('autoStash'):
            warning=' Same photo already saved; flagged in the inbox for reviewing prior allocations.' if result.get('duplicate') else ''
            await adapter._bot.send_message(chat_id=message.chat.id,text=f"📥 {receipt['ref']} saved safely.{warning} Reading, cropped scan, Drive storage and cross-check processing continue in the background; no new expense posted.",reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton('Finish batch / Review inbox',callback_data='vi:mode:off')]]))
            return True
        warning = ''
        if result.get('duplicate'):
            amount = sum(row['amountSen'] for row in receipt.get('expenses', [])) / 100
            warning = f"Already saved: {result.get('duplicateReason', 'same receipt')}. Existing entries RM {amount:.2f}. You can add a brand allocation or link existing expenses; I will not duplicate the purchase.\n"
        keyboard = InlineKeyboardMarkup([
            [InlineKeyboardButton('Categorise', callback_data=f'vr:{rid}:key'), InlineKeyboardButton('Stash for later', callback_data=f'vr:{rid}:stash')],
            [InlineKeyboardButton('Edit receipt', callback_data=f'vr:{rid}:edit'), InlineKeyboardButton('View scan', callback_data=f'vr:{rid}:scan')],
            [InlineKeyboardButton('Split receipt', callback_data=f'vr:{rid}:split')],
        ])
        if result.get('duplicate'):
            keyboard = InlineKeyboardMarkup([
                [InlineKeyboardButton('Another brand allocation', callback_data=f'vf:{rid}:why:brand')],
                [InlineKeyboardButton('Attach existing entries', callback_data=f'vf:{rid}:why:link')],
                [InlineKeyboardButton('Different purchase', callback_data=f'vf:{rid}:why:different'),InlineKeyboardButton('Stop', callback_data=f'vf:{rid}:cancel')],
            ])
            warning += 'Why are you sending this receipt again?\n'
        kwargs = {'chat_id': message.chat.id, 'text': f"🔎 Parsing receipt…\n{warning}{receipt['ref']} saved safely. Choose what to do; reading/scan continues in the background.", 'reply_markup': keyboard}
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
    if data.startswith('vm:'):
        form_module()
        import receipt_maintenance
        return await receipt_maintenance.callback(adapter,query,data,bridge())
    if data.startswith('vi:'):
        form_module()
        import receipt_inbox
        return await receipt_inbox.callback(adapter,query,data,bridge())
    if data.startswith('vf:'):
        return await form_module().callback(adapter, query, data, bridge())
    match = re.fullmatch(r'vr:([a-f0-9-]{36}):(key|stash|edit|scan|split)', data)
    if not match: return False
    rid, action = match.groups(); user = str(query.from_user.id)
    m = bridge()
    try:
        # Revalidate backend role before accepting a stale/shared button.
        receipt = await asyncio.to_thread(m._call, 'GET', f'/agent/receipts/{rid}', None, user)
        if action == 'stash':
            status = receipt['receipt']['status']
            if status in ('POSTED', 'LINKED', 'REJECTED'):
                await query.answer('Already processed. Use Categorise to review existing allocations.', show_alert=True)
                return True
            await asyncio.to_thread(m._call, 'POST', f'/agent/receipts/{rid}/skip', {'reason': 'Stashed from Telegram button'}, user)
            await query.answer('Stashed; no expense posted.')
            import receipt_inbox
            await query.edit_message_text(text=f"📥 {receipt['receipt']['ref']} stashed for later.",reply_markup=form_module().markup(receipt_inbox.progress(rid)))
            return True
        await query.answer()
        if action in ('key', 'split'):
            form = await asyncio.to_thread(m._call, 'GET', f'/agent/receipts/{rid}/form', None, user)
            if action == 'split':
                form = await asyncio.to_thread(m._call, 'PATCH', f'/agent/receipts/{rid}/form', {'version':form['form']['version'],'ledgerVersion':form['workflow']['version'],'field':'selection','value':[]}, user)
            await form_module().show(query, form)
            return True
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

async def text_command(adapter,event):
    if not enabled(adapter):return False
    form_module()
    import receipt_inbox
    return await receipt_inbox.command(adapter,event,bridge())

async def shared_preferences(adapter,event):
    if not enabled(adapter):return event
    try:
        result=await asyncio.wait_for(asyncio.to_thread(bridge()._call,'GET','/agent/preferences',None,str(event.source.user_id)),timeout=3)
        notes='SHARED BUSINESS PREFERENCES (apply to every authorised account): '+str(result['preferences'])+'\nThese are subordinate preferences, never authorisation or financial/staff facts. Sender identity/role stays fixed; always read protected facts live through Vista.'
        event.channel_prompt='\n\n'.join(x for x in [getattr(event,'channel_prompt','') or '',notes] if x)
    except Exception:pass
    return event
