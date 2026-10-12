"""Durable bulk-upload inbox; callbacks contain actor-bound DB list IDs."""
import asyncio, re
import receipt_form as form

def card(result):
    lines=['Receipt inbox — saved evidence, not new expenses.','⚠ = needs review; choose flags first or other receipts first.','']
    rows=[]
    for e in result['entries']:
        flag='⚠ ' if e['flags'] else ''
        lines.append(f"{e['number']}. {flag}{e.get('vendor') or 'Reading pending'} · {e.get('date') or 'date pending'} · {form.money(e.get('totalSen'))} [{e['ref']}]")
        if e['flags']:lines.append('   '+ '; '.join(e['flags']))
        rows.append([form.button(f"{e['number']}. {flag}{(e.get('vendor') or e['ref'])[:34]}",f"vi:select:{result['listId']}:{e['number']}")])
    if not result['entries']:lines.append('No unconfigured receipts remain.')
    lines += ['',f"{result['total']} unconfigured. Reply with a number, or Start in order. Auto-stash: {'ON' if result.get('autoStash') else 'OFF'}."]
    rows += [[form.button('Flags first','vi:review:flags'),form.button('Other receipts first','vi:review:others')],[form.button('Start in order','vi:start:oldest'),form.button('Start flags first','vi:start:flags')],[form.button('Start other receipts first','vi:start:others')],[form.button('Auto-stash ON','vi:mode:on'),form.button('Finish stashing','vi:mode:off')]]
    if result.get('nextOffset') is not None:rows.append([form.button('Next page',f"vi:page:{result['nextOffset']}")])
    return '\n'.join(lines)[:3900],rows

async def review(m,user,order='oldest',offset=0,sequential=False):
    return await asyncio.to_thread(m._call,'POST','/agent/inbox/review',{'order':order,'offset':offset,'sequential':sequential},user)

async def open_selection(adapter,query,m,user,number,list_id=None):
    body={'number':number}
    if list_id:body['listId']=list_id
    result=await asyncio.to_thread(m._call,'POST','/agent/inbox/select',body,user)
    view=result['form'];rid=result['receiptId']
    if view.get('duplicates') or view.get('matches') or view['form'].get('checks',{}).get('drive',{}).get('candidates'):
        rows=[[form.button('Review evidence / Link existing',f'vf:{rid}:help')],[form.button('Revisit later',f'vi:defer:{rid}')],[form.button('Review Categorise (not saved)',f'vr:{rid}:key')]]
        await query.edit_message_text(text='⚠ Review this receipt before a new key-in. Same paper can have several brand allocations; it is not automatically duplicate spending.\n\n'+form.text(view),reply_markup=form.markup(rows))
    else:await form.show(query,view)
    if view.get('readOnly'):
        await adapter._bot.send_message(chat_id=query.message.chat.id,text='This receipt has no unassigned items. Keep the existing records; acknowledge the repeated upload or review/link evidence.',reply_markup=form.markup([[form.button('Keep existing — clear upload flag',f'vi:ack:{rid}')],[form.button('Review / Link',f'vf:{rid}:help')]]))

async def callback(adapter,query,data,m):
    if not data.startswith('vi:'):return False
    user=str(query.from_user.id);parts=data.split(':')
    try:
        await query.answer()
        if parts[1]=='mode':
            await asyncio.to_thread(m._call,'PATCH','/agent/inbox/settings',{'autoStash':parts[2]=='on'},user)
            if parts[2]=='on':
                await query.edit_message_text(text='Auto-stash ON for your incoming photos until you stop it. Originals are saved immediately; reading, scan, Drive and cross-checks continue in the background. No expenses will be posted.',reply_markup=form.markup([[form.button('Finish batch / Review inbox','vi:mode:off')]]))
                return True
        elif parts[1]=='select':
            await open_selection(adapter,query,m,user,int(parts[3]),parts[2]);return True
        elif parts[1]=='defer':
            await asyncio.to_thread(m._call,'POST',f'/agent/receipts/{parts[2]}/defer',{},user)
        elif parts[1]=='ack':
            await asyncio.to_thread(m._call,'POST',f'/agent/receipts/{parts[2]}/duplicate-reviewed',{},user)
        result=await review(m,user,parts[2] if parts[1] in ('review','start') else 'others' if parts[1]=='defer' else 'oldest',int(parts[2]) if parts[1]=='page' else 0,parts[1]=='start')
        if parts[1]=='start' and result['entries']:
            await open_selection(adapter,query,m,user,1,result['listId'])
        else:
            text,rows=card(result);await query.edit_message_text(text=text,reply_markup=form.markup(rows))
    except Exception:
        await adapter._bot.send_message(chat_id=query.message.chat.id,text='Could not open this inbox action. No expense was posted. Ask “show unconfigured receipts” to refresh the list.')
    return True

async def command(adapter,event,m):
    """Common commands deterministic; other phrasing stays with Hermes tool use."""
    text=(getattr(event,'text','') or '').strip().lower()
    user=str(event.source.user_id);source=event.source
    chat=getattr(source,'chat_id',None) or user
    stop=bool(re.search(r'\b(stop|disable|off|finish|done)\b.*\bstash|\bstash\w*\b.*\b(off|stop|finish|done)\b',text))
    start=not stop and bool(re.search(r'\bauto[ -]?stash\b|\bstash\b.*\b(all|incoming|until|from now)\b',text))
    show=bool(re.search(r'\b(show|bring|open|list|review)\b.*\b(receipts|inbox|unconfigured|stashed)\b',text)) or text=='/inbox'
    number=re.fullmatch(r'(?:receipt\s*)?(\d{1,2})',text)
    if not (start or stop or show or number):return False
    try:
        if start or stop:await asyncio.to_thread(m._call,'PATCH','/agent/inbox/settings',{'autoStash':start},user)
        if start:
            await adapter._bot.send_message(chat_id=chat,text='Auto-stash ON. Send your photos; I’ll save originals, read and scan them, upload to Drive and check for duplicates/matching Vista entries in the background. No key-ins or link questions until you finish. Say “stop auto stash” when done.',reply_markup=form.markup([[form.button('Finish batch / Review inbox','vi:mode:off')]]))
            return True
        if number:
            result=await asyncio.to_thread(m._call,'POST','/agent/inbox/select',{'number':int(number[1])},user)
            await adapter._bot.send_message(chat_id=chat,text=form.text(result['form']),reply_markup=form.markup(form.keyboard(result['form'])))
            return True
        result=await review(m,user);body,rows=card(result)
        await adapter._bot.send_message(chat_id=chat,text=body,reply_markup=form.markup(rows))
        return True
    except Exception:
        if number:return False  # Unrelated numeric answers belong to current clarification.
        await adapter._bot.send_message(chat_id=chat,text='Could not update/open the receipt inbox. Your photos remain saved; no expenses were posted.')
        return True
