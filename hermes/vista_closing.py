"""The owner's daily closing: Vista compares each line, the owner confirms natively.



The model reads the figures and asks for a preview. Only the owner's own

Confirm button (callback vc:s:<id>) writes the interest line and bank check.

"""

import asyncio, re

from datetime import datetime

from decimal import Decimal



def parse_log(text):

    """Strict common-format fast path; uncertain inputs go to the normal conversation."""

    header=re.search(r'(?i)\b(\d{1,2}/\d{1,2}/(?:\d{4}|\d{2}))\s+CLOSING\b',text)

    if not header:return None

    raw=header[1];day=datetime.strptime(raw,'%d/%m/%Y' if len(raw.split('/')[-1])==4 else '%d/%m/%y').date().isoformat()

    money=r'(\d[\d,]*(?:\.\d{1,2})?)'

    sales=re.search(r'(?i)\bSales\s*=\s*RM\s*'+money,text)

    expenses=re.search(r'(?i)\bExpenses\s*=\s*RM\s*('+r'\d[\d,]*(?:\.\d{1,2})?|[-–—]'+r')(?=\s|$)',text)

    banks=re.findall(r'(?i)\bBank\s+Balance\s*=\s*RM\s*'+money,text)

    total=re.search(r'(?i)\bTotal\s*=\s*RM\s*'+money,text)

    if not sales or not expenses or len(banks)!=2 or not total:return None

    interest=re.search(r'(?i)\+\s*RM\s*'+money+r'\s*interest\b',text)

    incoming=re.search(r'(?i)\bOther\s+inflows\s*=\s*RM\s*'+money,text)

    other=re.search(r'(?i)\bOther\s+outflows\s*=\s*RM\s*'+money,text)

    sen=lambda v:int(Decimal(v.replace(',',''))*100)

    # Reject an unparsed sales addition, so fees/transfers never become interest.

    between=text[sales.end():expenses.start()]

    remaining=re.sub(r'(?i)\+\s*RM\s*'+money+r'\s*interest\b','',between)

    if remaining.strip():return None

    result={'businessDate':day,'salesSen':sen(sales[1]),'expensesSen':0 if expenses[1] in '-–—' else sen(expenses[1]),

            'interestSen':sen(interest[1]) if interest else 0,'openingBankSen':sen(banks[0]),'closingBankSen':sen(banks[1]),'statedTotalSen':sen(total[1])}

    if other:result['otherOutflowsSen']=sen(other[1])

    if incoming:result['otherInflowsSen']=sen(incoming[1])

    amounts=re.findall(r'(?i)RM\s*'+money,text)

    expected=6+(1 if interest else 0)+(1 if other else 0)+(1 if incoming else 0)-(1 if expenses[1] in '-–—' else 0)

    # Format has an optional +/- movement line; other monetary lines need conversation.

    if len(amounts) not in (expected,expected-1):return None

    return result



def status_text(result):

    rows=result.get('closings',[])

    if not rows:return 'No daily closings saved yet.'

    out=[]

    for row in rows:

        d=row['detail'];flags=d.get('flags',[])

        out.append(d['input']['businessDate']+' · '+('complete' if not flags else ', '.join(f.lower().replace('_',' ') for f in flags))+

                   ' · expenses '+rm(d['actualExpensesSen'])+' / '+rm(d['input']['expensesSen']))

    return '\n'.join(out)[:3900]



def refresh_evidence(m):

    """Support either arrival order for clearly labelled bank-interest entries.

    No ledger writes: only attach a document to a closing with identical date/amount.

    """

    result=m._call('GET','/agent/closing/status',None,m._default_user())

    import chopper_receipts as cr

    closings={c['detail']['input']['businessDate']:c for c in result.get('closings',[])}

    if not closings:return result

    candidates={}

    with cr.db() as c:ids=[row['id'] for row in c.execute("SELECT id FROM receipts WHERE state NOT IN ('RETIRED','SUBMITTING')")]

    for rid in ids:

        r=cr.get(rid);v=r['data'];rd=v.get('reading') or {}

        if not v.get('evidenceOnly') or not v.get('scanVerified') or any(f not in ('bank_screenshot','bank_statement') for f in rd.get('flags',[])):continue

        amounts={}

        for e in rd.get('interestEntries',[]):

            day=e.get('date');amount=e.get('amountSen')

            if isinstance(day,str) and isinstance(amount,int) and amount>0:amounts[day]=amounts.get(day,0)+amount

        for day,amount in amounts.items():

            closing=closings.get(day)

            if not closing or closing['detail']['input']['interestSen']!=amount:continue

            if closing['detail'].get('evidence',{}).get('interest'):continue

            candidates.setdefault(day,[]).append((rid,r['actor']))

    for day,matches in candidates.items():

        if len(matches)!=1:continue

        rid,actor=matches[0]

        m._call('POST','/agent/closing/evidence',{'businessDate':day,'purpose':'interest','receiptKey':rid},actor)

    return result



async def command(adapter,event,m):

    text=(getattr(event,'text','') or '').strip();actor=str(event.source.user_id);chat=getattr(event.source,'chat_id',None) or actor

    text=re.sub(r'@chopper67bot\b','',text,flags=re.I)

    if text.lower()=='/closing':

        import chopper_receipts as cr

        await asyncio.to_thread(cr.authorise,m,actor)

        if cr.settings(actor).get('bulk'):

            await adapter._bot.send_message(chat_id=chat,text='Bulk mode is active. Use /end to finish it before starting a closing.');return True

        cr.settings(actor,**{**{field:None for field in cr.MODE_FIELDS},'closingMode':True,'closingChat':str(chat)})

        await adapter._bot.send_message(chat_id=chat,text='Paste your partner’s daily CLOSING log. I will show the figures for confirmation. You can keep chatting normally; /end clears the prompt.');return True

    if text.lower().startswith('/closing '):text=text[len('/closing '):].strip()

    if text.lower()=='/closings':

        result=await asyncio.to_thread(m._call,'GET','/agent/closing/status',None,actor)

        await adapter._bot.send_message(chat_id=chat,text=status_text(result));return True

    evidence=re.fullmatch(r'(?i)/evidence\s+(\d{4}-\d{2}-\d{2})\s+(interest|bank)\s+(R-[0-9a-f]{6})',text)

    if evidence:

        result=await asyncio.to_thread(m._call,'POST','/agent/closing/evidence',{'businessDate':evidence[1],'purpose':evidence[2].lower(),'receiptKey':evidence[3].upper()},actor)

        await adapter._bot.send_message(chat_id=chat,text='Evidence linked. '+status_text({'closings':[result['closing']]}));return True

    transfer=re.fullmatch(r'(?is)/transfer\s+(R-[0-9a-f]{6})\s+(.{1,200})',text)

    if transfer:

        import chopper_receipts as cr

        rid=transfer[1].upper()

        def edit():

            with cr.receipt_lock(rid):

                cr.authorise(m,actor);r=cr.get(rid,actor);v=r['data'];rd=v.get('reading') or {}

                if not rd.get('totalSen') or not rd.get('date'):raise ValueError('Set the transfer amount and transaction date in Edit reading first.')

                if v.get('recorded') or any(x=='posted' for x in v.get('decisions',[])):raise ValueError('Already recorded: use its existing expense, do not enter it again.')

                cr.invalidate(r);rd['manualPurpose']=transfer[2].strip();rd['lines']=[{'name':rd['manualPurpose'],'quantityMilli':1000,'unitPriceSen':rd['totalSen'],'amountSen':rd['totalSen']}]

                rd['flags']=[f for f in rd.get('flags',[]) if f not in ('bank_screenshot','bank_statement')];rd['paymentMethod']='BANK_TRANSFER'

                v.update(reading=rd,decisions=['pending'],selected=[0],warning=None,evidenceOnly=False);r=cr.save(r)

                r=cr.check_duplicates(m,r);cr.sync_soon(m);return r

        r=await asyncio.to_thread(edit)

        await adapter._bot.send_message(chat_id=chat,text='Transfer purpose saved from your description. Review the date, amount and payee, then Categorise or link to the existing expense shown on the card.')

        await cr.card(adapter,m,r,chat);return True

    try:body=parse_log(text)

    except (ValueError,ArithmeticError):body=None

    if body is None:

        if not text.startswith('/'):

            import chopper_receipts as cr

            state=cr.settings(actor)

            if state.get('closingMode') and state.get('closingChat')==str(chat):

                # A prompt is not a conversation lock. Nonstandard logs need the

                # normal conversation/parser, and questions/evidence must pass

                # through rather than being swallowed by a repeated reminder.

                cr.settings(actor,closingMode=None,closingChat=None)

        return False

    result=await asyncio.to_thread(m._call,'POST','/agent/closing/preview',body,actor)

    message,rows=preview_card(result)

    from telegram import InlineKeyboardMarkup

    await adapter._bot.send_message(chat_id=chat,text=message,reply_markup=InlineKeyboardMarkup(rows))

    import chopper_receipts as cr

    state=cr.settings(actor)

    if state.get('closingMode') and state.get('closingChat')==str(chat):cr.settings(actor,closingMode=None,closingChat=None)

    return True



def rm(sen):

    if sen is None: return '—'

    return f"{'-' if sen < 0 else ''}RM{abs(sen)/100:,.2f}"



def mark(diff):

    if diff is None: return ''

    return ' ✅' if diff == 0 else f' ⚠ off by {rm(diff)}'



def preview_card(result):

    l = result['lines']

    s, i, e, o, a, c = l['sales'], l['interest'], l['expenses'], l['openingBank'], l['arithmetic'], l['closingBank']

    lines = [f"Closing {result['businessDate']} — NOT saved yet.", '']

    lines.append(f"Sales {rm(s['closingSen'])} · Vista {rm(s['vistaSen'])}{mark(s['differenceSen'])}")

    lines.append(f"Interest {rm(i['closingSen'])} · " + ('will be recorded as bank interest' if i['willWrite'] else 'already recorded'))

    exp = f"Expenses {rm(e['closingSen'])} · Vista paid from stall {rm(e['vistaStallPaidSen'])}{mark(e['differenceSen'])}"

    if e['vistaPartnerPaidSen']: exp += f" (+{rm(e['vistaPartnerPaidSen'])} paid by partners, not from the bank)"

    lines.append(exp)

    coupons=l.get('coupons',{})
    if coupons.get('receivableSen'):lines.append('Coupon sales not yet bank cash: '+rm(coupons['receivableSen'])+' (receivable; not an expense or bank payment).')
    if coupons.get('alreadyIncludedInSalesSen'):lines.append('Older coupon claims received within your reported Sales: '+rm(coupons['alreadyIncludedInSalesSen'])+' (already counted; no extra cash posted).')
    if coupons.get('inclusionPending'):lines.append('Received older coupon claim saved; confirm whether included in Sales before adding bank cash.')
    if coupons.get('collectedSen'):lines.append('Coupon claims received: '+rm(coupons['collectedSen'])+' (existing sales; not another sale).')
    incoming=l.get('otherInflows',{})

    if incoming.get('closingSen') or incoming.get('vistaSen'):

        lines.append(f"Other inflows {rm(incoming.get('closingSen',0))} · Vista incoming funding {rm(incoming.get('vistaSen',0))}{mark(incoming.get('differenceSen'))}")

        lines.append('Existing incoming funds are reused; this closing does not book them again.')

    other=l.get('otherOutflows',{})

    if other.get('closingSen') or other.get('vistaSen'):

        lines.append(f"Other outflows {rm(other.get('closingSen',0))} · Vista repayments/drawings {rm(other.get('vistaSen',0))}{mark(other.get('differenceSen'))}")

        lines.append('Existing outgoing payments are reused; this closing does not pay or book them again.')

    if o['vistaSen'] is None: lines.append(f"Opening bank {rm(o['closingSen'])} · no earlier bank balance in Vista; this becomes the starting point")

    else: lines.append(f"Opening bank {rm(o['closingSen'])} · Vista {o['vistaDate']} {rm(o['vistaSen'])}{mark(o['differenceSen'])}")

    if a['totalDifferenceSen']: lines.append(f"Your Total {rm(a['statedTotalSen'])} but opening + cash movements (including coupon timing) = {rm(a['ownTotalSen'])}")

    if c['shortSen'] is None: lines.append(f"Closing bank {rm(c['closingSen'])}")

    elif c['shortSen'] == 0: lines.append(f"Closing bank {rm(c['closingSen'])} · Vista expects {rm(c['vistaExpectedSen'])} ✅ balanced")

    else: lines.append(f"Closing bank {rm(c['closingSen'])} · Vista expects {rm(c['vistaExpectedSen'])} ⚠ {'short' if c['shortSen'] < 0 else 'over'} {rm(abs(c['shortSen']))}")

    if c['alreadyRecorded']: lines.append('This bank balance is already recorded for that day.')

    if result.get('locked'): lines.append('That period is closed: the interest line cannot be changed.')

    missing=result.get('missingReceipts',[]);remaining=result.get('remainingExpensesSen',e['differenceSen'])

    if remaining>0:lines.append('Awaiting expense details / receipts: '+rm(remaining)+'. Send now or later; this stays flagged.')

    elif remaining<0:lines.append('Existing expenses exceed this closing by '+rm(-remaining)+'. Review the date/entries.')

    if missing:lines.append(str(len(missing))+' existing expense(s) still need receipts or transfer evidence. You can defer.')

    if i['closingSen']:lines.append('Send the bank statement screenshot to support the interest. It will not be booked as an expense.')

    lines += ['', 'Confirm saves the closing and its outstanding flags. Existing sales/expenses are reused; a missing amount is never posted twice.']

    rows = [[{'text': 'Confirm closing', 'callback_data': f"cr:closing:s:{result['confirmationId']}"}],

            [{'text': 'Cancel', 'callback_data': 'cr:closing:c:0'}]]

    return '\n'.join(lines)[:3900], rows



async def callback(adapter, query, data, m):

    match = re.fullmatch(r'vc:([sce]):(\d{1,19})', data)

    if not match: return False

    kind, confirmation = match.groups(); user = str(query.from_user.id)

    try:

        await query.answer()

        if kind == 'c':

            await query.edit_message_text(text='Cancelled. Nothing recorded.'); return True

        if kind == 'e':

            r=await asyncio.to_thread(m._call,'POST','/agent/closing/expense/confirm',{'confirmationId':confirmation},user)

            await query.edit_message_reply_markup(reply_markup=None)

            await adapter._bot.send_message(chat_id=query.message.chat.id,text='Expense saved once. Supporting receipt or transfer screenshot can be linked later; missing evidence stays flagged.');return True

        r = await asyncio.to_thread(m._call, 'POST', '/agent/closing/confirm', {'confirmationId': confirmation}, user)

        parts = []

        if r['interest'] == 'written': parts.append(f"bank interest {rm(r['interestSen'])} added to the cash book")

        elif r['interest'] == 'amended': parts.append(f"bank interest corrected to {rm(r['interestSen'])}")

        elif r['interest'] == 'removed': parts.append('bank interest removed')

        parts.append('closing bank balance recorded' if r['balanceCheck'] == 'recorded' else 'bank balance was already recorded')

        await query.edit_message_reply_markup(reply_markup=None)

        suffix='\n'+status_text({'closings':[r['closing']]}) if r.get('closing') else ''

        if r.get('closing'):

            d=r['closing']['detail']

            if d.get('remainingExpensesSen',0)>0:suffix+='\nSend receipts / transfer screenshots for '+rm(d['remainingExpensesSen'])+', or type the expense details. You can leave this for later; /closings keeps the flag.'

            elif d.get('missingReceiptExpenseIds'):suffix+='\nSend the supporting receipts or transfer screenshots when ready. You can leave this for later.'

            if 'AWAITING_INTEREST_EVIDENCE' in d.get('flags',[]):suffix+='\nSend the bank statement screenshot showing the interest.'

        await adapter._bot.send_message(chat_id=query.message.chat.id, text=f"✅ Closing {r['businessDate']}: " + '; '.join(parts) + '.'+suffix)

    except Exception as error:

        text = str(error)

        if 'ALREADY_CONFIRMED' in text: msg = 'This closing was already confirmed. Nothing recorded twice.'

        elif 'PREVIEW_STALE' in text: msg = 'That day changed since this preview. Send the closing again for a fresh check.'

        else: msg = 'Could not confirm the closing. Nothing was assumed saved: check Cashflow in the RMS, then send the closing again for a fresh preview.'

        await adapter._bot.send_message(chat_id=query.message.chat.id, text=msg)

    return True

