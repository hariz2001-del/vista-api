"""Owner-only native confirmations. The model can preview, never confirm."""
import asyncio, re
import receipt_form as form

def preview_card(kind,id,result):
    if kind=='e':
        before,after=result['before'],result['after']
        lines=['Review expense correction — NOT saved.','Original receipt photo remains unchanged.','']
        for field,value in after.items():
            old=before.get(field)
            if field=='businessDate':old=str(old)[:10]
            if field=='items':
                lines += ['Proposed items:']+[f"{l['name']} ×{l['quantityMilli']/1000:g} @ {form.money(l['unitPriceSen'])}" for l in value]
            elif old!=value:lines.append(f'{field}: {form.money(old) if field=="amountSen" else old} → {form.money(value) if field=="amountSen" else value}')
        lines.append('Vista enforces locked-period, reimbursement and cash-book correction rules.')
        title='Confirm edit'
    else:
        lines=['Review duplicate-photo cleanup — NOT deleted.',f"Duplicate: R-{id[:6].upper()}",f"Keep canonical: R-{result['canonicalReceiptId'][:6].upper()}"]
        lines += [f"Trash: {f['name']}" for f in result['files']]
        lines += ['Duplicate Vista image cache will be removed; metadata/audit kept.','Drive photos go to recoverable Trash. Canonical evidence and booked entries stay untouched.']
        title='Confirm duplicate cleanup'
    rows=[[form.button(title,f"vm:{kind}:{id}:{result['confirmationId']}")],[form.button('Cancel',f'vm:c:{id}:0')]]
    return '\n'.join(lines)[:3900],rows

async def callback(adapter,query,data,m):
    match=re.fullmatch(r'vm:([edc]):([a-f0-9-]{36}):(\d{1,19})',data)
    if not match:return False
    kind,id,confirmation=match.groups();user=str(query.from_user.id)
    try:
        await query.answer()
        if kind=='c':
            await query.edit_message_text(text='Cancelled. No edit or cleanup performed.');return True
        path=f'/agent/expenses/{id}/edit/confirm' if kind=='e' else f'/agent/receipts/{id}/cleanup/confirm'
        result=await asyncio.to_thread(m._call,'POST',path,{'confirmationId':confirmation},user)
        text='✅ Expense corrected using Vista rules; original receipt preserved.' if kind=='e' else f"Removed duplicate image cache and trashed {result['removedPhotos']} duplicate Drive photos. Recoverable in Drive Trash. Canonical receipt and accounting unchanged."
        await adapter._bot.send_message(chat_id=query.message.chat.id,text=text)
    except Exception:
        await adapter._bot.send_message(chat_id=query.message.chat.id,text='Could not verify this maintenance result. Check current Vista entry/Drive Trash before retrying; request a fresh preview. No new expense was posted.')
    return True
