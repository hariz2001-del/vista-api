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

def closing_context(m, actor, text):
    """Date-labelled live bank comparisons prevent stale history/sign guesses."""
    if not re.search(r'(?i)closing|coupon|kupon|variance|bank|balance|rm\s*24|perbezaan',text or ''):return ''
    import json
    try:
        result=m._call('GET','/agent/closing/status',None,actor)
        rows=[]
        for c in result.get('closings',[]):
            d=c['detail'];bank=d['comparison']['lines']['closingBank']
            rows.append({'date':d['input']['businessDate'],'statedSen':bank['closingSen'],'expectedSen':bank['vistaExpectedSen'],'statedMinusExpectedSen':bank['shortSen'],'direction':bank['differenceDirection'],'flags':d['flags']})
        return ' LIVE CLOSINGS FOR THIS TURN (integer sen, date-specific): '+json.dumps(rows)+'. Use the date the owner actually named, never silently select the newest closing. If the same amount appears across days, report each actual date, amount and direction from these live rows, and clarify linkage. Do not reuse old day-specific amounts or signs after a bank-balance correction. Equal opposite differences may be timing but do not prove payment. Owner-confirmed unpaid coupon sales use vista_coupon_claim record_unpaid; a receipt against an existing unpaid claim uses collect with confirmed date. An older received claim whose original sale is not recorded uses record_prior_collection; save paid confirmation and clarify sales inclusion, never invent an unpaid claim. A missing screenshot is pending evidence, not a blanket reason to refuse owner-confirmed bookkeeping. Never book a collection from "suppose" or a bare variance.'
    except Exception:
        return ' Live closing read failed. Use vista_closing status for the exact date before stating figures or recording coupon money; do not fall back to old assistant figures.'

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
        'Daily CLOSING logs use vista_closing preview/status/evidence. Standard logs are handled natively without a model call. '
        'Closings reuse expenses by actual transaction date; never post the declared expense total again. '
        'Missing receipts and unmatched totals remain flagged; the user may defer. Read vista_closing status for outstanding work. '
        'An owner-confirmed older coupon RECEIVED on a date is not unpaid. Use record_prior_collection even without its old sale date or screenshot. Confirm whether included in the reported Sales figure before adding cash; an unknown inclusion saves paid confirmation pending classification without posting extra money. '
        'Coupon claims have a dedicated vista_coupon_claim tool: record unpaid existing-sales receivables and collect only on the owner-confirmed actual date. Do not demand a screenshot as a prerequisite; keep missing payment evidence flagged. '
        'For a new manually described expense without paper receipt use vista_manual_expense after collecting real category/funding/brand choices; only native confirmation saves it. '
        'Bank screenshots may support interest, balances, purchases or partner repayments. Use the owner caption and conversation purpose; do not repeatedly ask for information already supplied. Never fabricate purchase items. Inspect saved evidence via chopper_receipts; vista_closing evidence attaches interest/balance support. '
        'If a partner temporarily advances cash pending organiser coupon reimbursement, payment back is LOAN_REPAYMENT, not a purchase expense or owner drawing. Use vista_partner_advance only after the owner explicitly identifies an already-paid advance repayment, date, amount and payee. Never invent the original advance or organiser deposit. Resolve actual brand names from vista_options; enum PARTNER_DRINKS does not necessarily mean the brand named Drinks. '
        'Bank comparison: shortSen = stated minus expected. Positive is OVER/above expected; negative is SHORT/below. Use differenceDirection and interpretation from the API. Evidence never removes a numerical difference by itself. '
        'A bank-transfer screenshot can support a purchase expense. With the owner purpose use chopper_receipts action=transfer_expense, receipt_id, description and vendor from the visible beneficiary (not bank logo). If still PROCESSING, the tool durably queues this same receipt until the existing scan finishes; do not say it cannot be logged or ask for another upload. Explicit purchase captions also continue automatically after OCR. /transfer R-XXXXXX description is implemented. Income/interest/closing evidence and partner repayments are separate. Use native category flow for the resulting expense. '
        'Unique exact date+amount+merchant hand-keyed matches can auto-link evidence under the owner standing instruction; ambiguous matches need review. '
        'Chopper has an independent direct Google Drive connection through mcp__finances_drive__chopper_drive, scoped to Finances, owner-only. '
        'Use chopper_drive for Drive browsing, folders, uploads, rename/move, and previewed replacement/Trash/restore. '
        'Those Google file operations do not go through Vista. Receipt image changes notify Vista separately; '
        'pending sync does not mean the Drive action failed and must never cause repeating replacement/deletion. '
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
    try:
        import vista_mcp as m
        context+=closing_context(m,str(event.source.user_id),getattr(event,'text','') or '')
    except Exception:pass
    # Sender/chat-bound context makes a following bare date refer to the actual
    # recent photo, without selecting another person's or another chat's evidence.
    try:
        import time,json,chopper_receipts as cr
        actor=str(event.source.user_id);chat=str(getattr(event.source,'chat_id',None) or actor);s=cr.settings(actor)
        if s.get('lastPhoto') and s.get('lastPhotoChat')==chat and 0<=time.time()-s.get('lastPhotoAt',0)<7200:
            r=cr.get(s['lastPhoto'],actor)
            context+=' RECENT PHOTO IN THIS SENDER/CHAT: '+json.dumps({'receiptKey':r['id'],'status':r['state'],'ownerCaption':r['data'].get('ownerCaption'),'reading':r['data'].get('reading'),'evidenceOnly':r['data'].get('evidenceOnly'),'partnerRepayment':r['data'].get('partnerRepayment'),'partnerAdvance':r['data'].get('partnerAdvance'),'transferDirection':r['data'].get('transferDirection')},ensure_ascii=False)+'. Use this evidence when the owner follows up with its date/purpose. Call the appropriate write tool and report its result; merely repeating figures does not attach evidence.'
    except Exception:pass
    event.channel_prompt = '\n\n'.join(x for x in [getattr(event, 'channel_prompt', '') or '', context] if x)
    # Hermes' supported auto-skill path avoids a separate model/tool round trip.
    event.auto_skill = 'sarang-bookkeeping'
    return event

def enabled(adapter):
    return Path(str(getattr(adapter, '_update_receipt_dir', ''))) == HOME

def menu_commands(adapter,commands):
    if not enabled(adapter):return commands
    return [('receipt','Parse the next photo as a purchase receipt'),('evidence','Use the next bank screenshot as evidence'),('closing','Paste a daily closing log'),('bulk','Silently scan and store a receipt batch'),('end','Finish the active mode and keep saved work'),('stash','Open saved receipts for later'),('closings','Check daily closings and missing evidence')] + [row for row in commands if row[0] not in ('receipt','evidence','closing','bulk','end','endbulk','stash','closings')]

def bridge():
    spec = importlib.util.spec_from_file_location('sarang_receipt_bridge', HOME / 'integrations/vista_mcp.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name]=module
    spec.loader.exec_module(module)
    return module

PAUSED = HOME / 'receipts-paused'
PAUSE_TEXT = ('Receipt intake is paused while Chopper\'s receipt flow is being rebuilt. '
              'Nothing was saved or posted — please resend this photo once Chopper says receipts are back.')

async def photo(adapter, message, event, data):
    if not enabled(adapter): return False
    if PAUSED.exists():
        await adapter._bot.send_message(chat_id=message.chat.id, text=PAUSE_TEXT)
        return True
    form_module()
    import chopper_receipts
    if not chopper_receipts.enabled():
        await adapter._bot.send_message(chat_id=message.chat.id, text='Receipt intake is not enabled in the Chopper receipt core. Nothing was saved or posted.')
        return True
    return await chopper_receipts.photo(adapter, message, event, data, bridge())

async def callback(adapter, query, data):
    if not enabled(adapter): return False
    if data.startswith(('vc:','cr:closing:')):
        form_module()
        import vista_closing
        return await vista_closing.callback(adapter,query,data.replace('cr:closing:','vc:',1),bridge())
    if data.startswith('cr:'):
        form_module()
        import chopper_receipts
        return await chopper_receipts.callback(adapter, query, data, bridge())
    if data.startswith('dg:'):
        import chopper_drive
        return await chopper_drive.callback(adapter, query, data, bridge())
    if data.startswith(('vr:','vf:','vi:','vm:')):
        await query.answer('Old receipt button retired. Use /stash.',show_alert=True)
        return True
    return False

async def text_command(adapter,event):
    if not enabled(adapter):return False
    form_module()
    import vista_closing
    try:
        if await vista_closing.command(adapter,event,bridge()):return True
    except Exception as e:
        await adapter._bot.send_message(chat_id=getattr(event.source,'chat_id',None) or event.source.user_id,text='Closing request needs review: '+str(e)[:250])
        return True
    if PAUSED.exists():
        if (getattr(event,'text','') or '').strip().lower() in ('/bulk','/endbulk','/stash','/inbox'):
            await adapter._bot.send_message(chat_id=getattr(event.source,'chat_id',None) or event.source.user_id,text=PAUSE_TEXT)
            return True
    import chopper_receipts
    if chopper_receipts.enabled():
        try:
            return await chopper_receipts.command(adapter,event,bridge())
        except Exception as e:
            await adapter._bot.send_message(chat_id=getattr(event.source,'chat_id',None) or event.source.user_id,text='Receipt request needs review: '+str(e)[:250])
            return True
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
