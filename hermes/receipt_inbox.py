"""Durable, numbered bulk intake and explicitly stepped receipt review."""
import asyncio,re
import receipt_form as form

def date_label(value):
    return f'{value[8:10]}/{value[5:7]}/{value[:4]}' if value and re.fullmatch(r'\d{4}-\d{2}-\d{2}',value) else '—'

def receipt_line(e):
    amount='—' if e.get('totalSen') is None else f"RM {e['totalSen']/100:,.2f}"
    vendor=e.get('vendor') or ('Scan needs review' if e.get('failed') else 'Parsing…')
    return f"{e['number']}. {e['ref']} — {vendor} · {date_label(e.get('date'))} · {amount}"

def card(result):
    lines=[receipt_line(e) for e in result['entries']];scope=result.get('listScope','all')
    rows=[[form.button(f"{e['number']}. {'⚠ ' if e.get('flags') else ''}{(e.get('vendor') or e['ref'])[:34]}",f"vi:select:{result['listId']}:{e['number']}")] for e in result['entries']]
    rows += [[form.button('Configure in order',f'vi:start:oldest:{scope}'),form.button('End','vi:end')]]
    if scope=='all':rows += [[form.button('Flags first','vi:review:flags:all'),form.button('Other receipts first','vi:review:others:all')]]
    for key,title in [('nextOffset','Next page'),('previousOffset','Previous page')]:
        if result.get(key) is not None:rows.append([form.button(title,f"vi:page:{result[key]}:{scope}")])
    return '\n'.join(lines) if lines else 'No receipts in this list.',rows

def progress(rid):
    return [[form.button('Next receipt',f'vi:next:{rid}'),form.button('End','vi:end')],[form.button('Choose custom receipt','vi:custom')]]

def action_menu(rid):
    return [[form.button('Categorise',f'vr:{rid}:key'),form.button('Stash for later',f'vr:{rid}:stash')],[form.button('Edit receipt',f'vr:{rid}:edit'),form.button('View scan',f'vr:{rid}:scan')],[form.button('Split receipt',f'vr:{rid}:split')]]

async def call(m,user,method,path,body=None):
    return await asyncio.to_thread(m._call,method,path,body,user)

async def review(m,user,order='oldest',offset=0,sequential=True,scope='all',bulk_id=None):
    return await call(m,user,'POST','/agent/inbox/review',{'order':order,'offset':offset,'sequential':sequential,'scope':scope,**({'bulkId':bulk_id} if bulk_id else {})})

async def present_receipt(adapter,chat,m,user,rid,view):
    try:
        result=await asyncio.to_thread(m._run,'vista_get_receipt',{'receipt_id':rid,'with_image':True,'original':False,'telegram_user_id':user})
        r=result['receipt'];path=r.get('image_path')
        if not path:raise ValueError('scan unavailable')
        with open(path,'rb') as stream:await adapter._bot.send_photo(chat_id=chat,photo=stream,caption=f"{r['ref']} — {r.get('vendor') or 'Receipt'} · {date_label(r.get('receiptDate'))}")
    except Exception:await adapter._bot.send_message(chat_id=chat,text='Stored scan unavailable or still processing. Receipt kept; View scan can retry.')
    rows=action_menu(rid)
    if view.get('duplicates') or view.get('matches') or view['form'].get('checks',{}).get('drive',{}).get('candidates'):rows += [[form.button('Review flags / Link existing',f'vf:{rid}:help')]]
    await adapter._bot.send_message(chat_id=chat,text=form.text(view),reply_markup=form.markup(rows))
    if view.get('readOnly'):await adapter._bot.send_message(chat_id=chat,text='Already handled; no unassigned items remain.',reply_markup=form.markup(progress(rid)))

async def open_selection(adapter,query,m,user,number,list_id=None):
    result=await call(m,user,'POST','/agent/inbox/select',{'number':number,**({'listId':list_id} if list_id else {})})
    await present_receipt(adapter,query.message.chat.id,m,user,result['receiptId'],result['form'])

async def callback(adapter,query,data,m):
    if not data.startswith('vi:'):return False
    user=str(query.from_user.id);p=data.split(':')
    try:
        await query.answer()
        if p[1]=='end':
            await call(m,user,'POST','/agent/inbox/end',{});await query.edit_message_text(text='Receipt review ended. Unconfigured receipts remain stored.');return True
        if p[1]=='next':
            result=await call(m,user,'POST','/agent/inbox/next',{'receiptId':p[2],'allowUnconfigured':True})
            if result.get('next'):
                n=result['next'];await present_receipt(adapter,query.message.chat.id,m,user,n['receiptId'],n['form'])
            else:await query.edit_message_text(text='No next receipt in this list.',reply_markup=form.markup([[form.button('Choose custom receipt','vi:custom'),form.button('End','vi:end')]]))
            return True
        if p[1]=='mode':
            await call(m,user,'PATCH','/agent/inbox/settings',{'autoStash':p[2]=='on'})
            if p[2]=='on':await query.edit_message_text(text='Auto-stash ON. Use /bulk for silent scan-only capture, /endbulk to finish.');return True
        elif p[1]=='select':await open_selection(adapter,query,m,user,int(p[3]),p[2]);return True
        elif p[1]=='defer':await call(m,user,'POST',f'/agent/receipts/{p[2]}/defer',{})
        elif p[1]=='ack':await call(m,user,'POST',f'/agent/receipts/{p[2]}/duplicate-reviewed',{})
        settings=await call(m,user,'GET','/agent/inbox/settings')
        context=await call(m,user,'GET','/agent/inbox/context') if p[1]=='custom' else {}
        scope=p[3] if len(p)>3 and p[1] in ('page','start','review') else context.get('listScope') or ('batch' if settings.get('bulkId') else 'all')
        result=await review(m,user,p[2] if p[1] in ('review','start') else 'others' if p[1]=='defer' else 'oldest',int(p[2]) if p[1]=='page' else 0,scope=scope,bulk_id=context.get('bulkId'))
        if p[1]=='start' and result['entries']:await open_selection(adapter,query,m,user,result['entries'][0]['number'],result['listId'])
        else:
            text,rows=card(result);await query.edit_message_text(text=text,reply_markup=form.markup(rows))
    except Exception:await adapter._bot.send_message(chat_id=query.message.chat.id,text='Could not open inbox action. No expense posted. Ask “show receipts” to refresh.')
    return True

async def command(adapter,event,m):
    text=(getattr(event,'text','') or '').strip().lower();user=str(event.source.user_id);chat=getattr(event.source,'chat_id',None) or user
    slash=re.fullmatch(r'/(bulk|endbulk)(?:@chopper67bot)?',text)
    stop=bool(re.search(r'\b(stop|disable|off|finish|done)\b.*\bstash|\bstash\w*\b.*\b(off|stop|finish|done)\b',text))
    start=not stop and bool(re.search(r'\bauto[ -]?stash\b|\bstash\b.*\b(all|incoming|until|from now)\b',text))
    show=bool(re.search(r'\b(show|bring|open|list|review)\b.*\b(receipts|inbox|unconfigured|stashed)\b',text)) or text=='/inbox'
    number=re.fullmatch(r'(?:(?:configure|receipt|choose)(?:\s+receipt)?\s*)?(\d{1,5})',text)
    in_order=bool(re.fullmatch(r'(?:configure|do it|do them|start)?\s*(?:by (?:the )?list|in order)',text))
    if not (slash or start or stop or show or number or in_order):return False
    try:
        if slash:
            action=slash[1];await call(m,user,'POST',f'/agent/inbox/bulk/{"start" if action=="bulk" else "end"}',{})
            if action=='bulk':await adapter._bot.send_message(chat_id=chat,text='Bulk mode ON. Send receipts; I’ll read and save colour cropped scans silently. Originals go to Drive Trash only after scan verification. Send /endbulk when finished.')
            else:
                ready=await asyncio.to_thread(m._bulk_notify,user)
                if not ready.get('sent'):
                    if ready.get('pending'):await adapter._bot.send_message(chat_id=chat,text='Finishing the remaining scans. Your numbered list will arrive automatically.')
                    else:
                        result=await review(m,user,scope='batch');body,rows=card(result);await adapter._bot.send_message(chat_id=chat,text=body,reply_markup=form.markup(rows))
            return True
        if start or stop:await call(m,user,'PATCH','/agent/inbox/settings',{'autoStash':start})
        if start:await adapter._bot.send_message(chat_id=chat,text='Auto-stash ON. For silent scan-only batches use /bulk then /endbulk.');return True
        if number:
            result=await call(m,user,'POST','/agent/inbox/select',{'number':int(number[1])});await present_receipt(adapter,chat,m,user,result['receiptId'],result['form']);return True
        settings=await call(m,user,'GET','/agent/inbox/settings');result=await review(m,user,scope='batch' if settings.get('bulkId') and text!='/inbox' else 'all')
        if in_order and result['entries']:
            selected=await call(m,user,'POST','/agent/inbox/select',{'listId':result['listId'],'number':result['entries'][0]['number']});await present_receipt(adapter,chat,m,user,selected['receiptId'],selected['form']);return True
        body,rows=card(result);await adapter._bot.send_message(chat_id=chat,text=body,reply_markup=form.markup(rows));return True
    except Exception:
        if number:return False
        await adapter._bot.send_message(chat_id=chat,text='Could not update/open receipt mode. Photos remain stored; no expenses posted. Please retry.');return True
