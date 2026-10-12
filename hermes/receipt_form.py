"""Native, restart-safe receipt card. Choices and accounting come from Vista.

No model calls for selecting category/brand/funding/method or preview/confirm.
Callback values are indexes bound to the live options and draft version.
"""
import asyncio, dataclasses, hashlib, json, re

def money(sen):
    return 'needs review' if sen is None else f'RM{sen/100:.2f}'

def label(options, field, value):
    if field=='brand':
        return 'Shared' if value=='SHARED' else next((x['name'] for x in options['brands'] if x['id']==value),'Choose brand')
    key={'category':'categories','funding':'paidBy','method':'paymentMethods'}[field]
    return next((x['label'] for x in options[key] if x['value']==value),'—')

def stamp(view):
    data=[view['options'],view['form']['version'],view['form']['readingHash']]
    return hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()[:6]

def text(view, page=0):
    r,f,o=view['receipt'],view['form'],view['options']
    lines=[r.get('vendor') or 'Merchant needs review',r.get('date') or 'Date needs review','']
    for i,line in list(enumerate(f['lines']))[page*8:page*8+8]:
        quantity='?' if line['quantityMilli'] is None else f"{line['quantityMilli']/1000:g}"
        lines.append(f"{i+1}. {line['name']} ×{quantity} — {money(line['amountSen'])}\n   ({label(o,'category',line['category']) or 'Choose category'} · {label(o,'brand',line['brand'])})")
    if not f['lines']: lines.append('Parsing receipt… You can stash it now, or reopen Categorise when the reading is ready.')
    lines += ['',f"Total: {money(r['totalSen'])}",f"Funding: {label(o,'funding',f['paidBy'])} · Method: {label(o,'method',f['paymentMethod'])}",f"Invoice: {r.get('receiptNo') or '—'} · {'photo attached' if r.get('photoAttached') else 'photo pending'}",r['ref']]
    if r.get('reviewFlags'): lines.append('Review: '+'; '.join(r['reviewFlags'])[:400])
    if view.get('readingChanged'):lines.append('The reading changed; earlier category choices were reset. Review again.')
    for c in view.get('duplicates',[])[:2]: lines.append(f"Possible same paper as {c['ref']}: {', '.join(c['reasons'])}. Ask Hermes to explain/reuse/split before saving.")
    if view.get('matches'):lines.append('Existing transactions may match. Link those instead of posting the purchase again; ask Hermes to review the evidence.')
    if view.get('readOnly'):lines.append('Already processed; no second full-receipt posting. Ask Hermes for a NEW brand allocation or to link existing entries.')
    return '\n'.join(lines)[:3900]

def button(name, data):
    assert len(data.encode())<=64, 'Telegram callback exceeds 64 bytes'
    return {'text':name[:60],'callback_data':data}

def keyboard(view,page=0):
    rid=view['receipt']['id'];prefix=f'vf:{rid}:';f,o=view['form'],view['options'];s=stamp(view)
    if view.get('readOnly'):
        return [[button('Review allocations / link existing',prefix+'help')],[button('View scan',f'vr:{rid}:scan')]]
    rows=[]
    for i,l in list(enumerate(f['lines']))[page*8:page*8+8]:
        rows.append([button(f"{i+1}. {l['name'][:22]} · {label(o,'category',l['category'])}",prefix+f'pick:c:{i}:{page}'),button(label(o,'brand',l['brand']),prefix+f'pick:b:{i}:{page}')])
    pages=(len(f['lines'])+7)//8
    if pages>1:rows.append([button(f'Lines {p*8+1}–{min((p+1)*8,len(f["lines"]))}',prefix+f'page:{p}') for p in range(pages)])
    rows.append([button('All categories',prefix+f'pick:c:a:{page}'),button('All brands',prefix+f'pick:b:a:{page}')])
    rows.append([button('Funding',prefix+f'pick:f:a:{page}'),button('Method',prefix+f'pick:m:a:{page}')])
    if o.get('split') and any(l['brand']=='SHARED' for l in f['lines']):rows.append([button('Shared split %',prefix+f'pick:s:a:{page}')])
    rows.append([button('✅ Save (preview)',prefix+f'save:{s}'),button('Cancel',prefix+'cancel')])
    rows.append([button('Edit reading',f'vr:{rid}:edit'),button('View scan',f'vr:{rid}:scan')])
    if view.get('matches') or view.get('duplicates'):rows.append([button('Explain duplicate / Link existing',prefix+'help')])
    if view.get('duplicates'):rows.extend(duplicate_keyboard(rid))
    return rows

def duplicate_keyboard(rid):
    return [[button('Another brand allocation',f'vf:{rid}:why:brand')],[button('Attach existing entries',f'vf:{rid}:why:link')],[button('Different purchase',f'vf:{rid}:why:different'),button('Stop',f'vf:{rid}:cancel')]]

def choices(view,field):
    o=view['options']
    if field=='c':return [(x['label'],x['value']) for x in o['categories']]
    if field=='b':return [(x['name'],x['id']) for x in o['brands']]+([('Shared','SHARED')] if o.get('split') else [])
    if field=='f':return [(x['label'],x['value']) for x in o['paidBy']]
    if field=='m':return [('Not specified',None)]+[(x['label'],x['value']) for x in o['paymentMethods']]
    return [('Vista defaults',None)]+[(f'{p}% {o["split"]["firstBrand"]} / {100-p}% {o["split"]["secondBrand"]}',p) for p in (0,25,50,70,75,100)]

def picker(view,field,index,page):
    rid=view['receipt']['id'];s=stamp(view)
    rows=[[button(name,f'vf:{rid}:set:{field}:{index}:{i}:{s}')] for i,(name,_) in enumerate(choices(view,field))]
    rows.append([button('Back',f'vf:{rid}:page:{page}')])
    return rows

def markup(rows):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([[InlineKeyboardButton(**b) for b in row] for row in rows])

async def show(query, view, page=0):
    await query.edit_message_text(text=text(view,page),reply_markup=markup(keyboard(view,page)))

async def handoff(adapter,query,rid,request):
    from gateway.platforms.base import MessageType
    user=str(query.from_user.id)
    event=adapter._build_message_event(query.message,MessageType.TEXT)
    event.source=dataclasses.replace(event.source,user_id=user,user_name=query.from_user.full_name,is_bot=False)
    event.text=f'{request} Receipt UUID {rid}. Already saved. Actual sender {user}. Do not re-upload, post or link without explicit confirmation. Use vista_receipt_form to show Categorise again after reading corrections.'
    event.message_id=f'vista-form-{query.id}'
    await adapter.handle_message(event)

async def callback(adapter,query,data,m):
    match=re.fullmatch(r'vf:([a-f0-9-]{36}):(.+)',data)
    if not match:return False
    rid,action=match.groups();user=str(query.from_user.id);path=f'/agent/receipts/{rid}/form'
    async def call(method,suffix='',body=None):return await asyncio.to_thread(m._call,method,path+suffix,body,user)
    try:
        view=await call('GET') # backend permission, actual actor, current settings
        await query.answer()
        if action=='cancel':
            await query.edit_message_text(text='Categorisation cancelled. Receipt kept safely; no expense posted.',reply_markup=markup([[button('Categorise',f'vr:{rid}:key'),button('Stash for later',f'vr:{rid}:stash')]]))
        elif action.startswith('why:'):
            reason=action.split(':')[1]
            request={'brand':'I resent this paper for another brand allocation. Inspect existing allocations and remaining balance. If none are posted, open the native Categorise card to configure all brands together; otherwise prepare only NEW remaining allocation, append=true and a fresh exact preview.', 'link':'I resent this paper to attach receipt evidence to existing entries. Find matching transactions, show each ID/date/vendor/amount and reasons; ask explicit confirmation of exact rows before linking. Do NOT post new spending.', 'different':'I believe this is a different purchase. Check the same-photo/invoice/date/vendor/total evidence and explain conflicts. Do not treat identical evidence as proof of another purchase or post it automatically; collect the correct distinct receipt or clarification.'}[reason]
            await handoff(adapter,query,rid,request)
        elif action=='help':
            await handoff(adapter,query,rid,'Explain duplicate receipt evidence and matching transactions. Ask why: another brand allocation, attach existing entries, or different purchase. Review prior allocations and remaining total. Give real choice buttons.')
        elif action.startswith('page:'):await show(query,view,int(action.split(':')[1]))
        elif action.startswith('pick:'):
            _,field,index,page=action.split(':')
            await query.edit_message_text(text='Choose from current Vista settings. '+('Applies to ALL lines.' if index=='a' else f'Line {int(index)+1} only.'),reply_markup=markup(picker(view,field,index,int(page))))
        elif action.startswith('set:'):
            _,field,index,option,s=action.split(':')
            if s!=stamp(view):raise ValueError('stale')
            options=choices(view,field);value=options[int(option)][1]
            body={'version':view['form']['version'],'field':{'c':'category','b':'brand','f':'funding','m':'method','s':'split'}[field],'value':value}
            if index!='a':body['lineIndex']=int(index)
            await show(query,await call('PATCH',body=body),0 if index=='a' else int(index)//8)
        elif action.startswith('save:'):
            if action.split(':')[1]!=stamp(view):raise ValueError('stale')
            preview=await call('POST','/preview')
            lines=['Review exact Vista entries — NOT saved yet.']
            for e in preview['entries']:
                lines.append(f"{money(e['amountSen'])} · {label(view['options'],'category',e['category'])} · {e['brand']}\nFunding: {label(view['options'],'funding',e['paidBy'])} · Method: {label(view['options'],'method',e.get('paymentMethod'))}")
                if e['brandId'] is None:lines.append(f"Shared split: {e['foodSplitPct']}% {view['options']['split']['firstBrand']}")
            lines.append('Total: '+money(preview['entriesTotalSen']))
            if preview.get('matches') or view.get('duplicates'):lines.append('WARNING: possible existing purchase/evidence. If this is the SAME purchase, link/reuse instead; do not confirm a duplicate expense.')
            await query.edit_message_text(text='\n\n'.join(lines)[:3900],reply_markup=markup([[button('✅ Confirm Save',f'vf:{rid}:post:{preview["confirmationId"]}')],[button('Back',f'vf:{rid}:page:0'),button('Cancel',f'vf:{rid}:cancel')]]+([[button('Review / Link existing',f'vf:{rid}:help')]] if preview.get('matches') or view.get('duplicates') else [])))
        elif action.startswith('post:'):
            result=await call('POST','/post',{'confirmationId':action.split(':')[1]})
            await query.edit_message_text(text=f"Saved {len(result.get('expenseIds',[]))} Vista entries. {view['receipt']['ref']} · {money(view['receipt']['totalSen'])}. Receipt retained in Drive.",reply_markup=markup([[button('View scan',f'vr:{rid}:scan')]]))
        else:return False
        return True
    except Exception as error:
        # Do not expose raw transport/provider errors or credentials.
        message='The form changed or an option is unavailable. Reopen Categorise; nothing new was posted.'
        if action.startswith('post:'):message='Could not confirm the save result. Reopen Categorise to check its current status before retrying.'
        if isinstance(error,m.VistaError) and 'FORM_INCOMPLETE' in str(error):message=str(error)[:180]
        await adapter._bot.send_message(chat_id=query.message.chat.id,text=message)
        return True
