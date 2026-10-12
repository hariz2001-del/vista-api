"""Bind Vista calls to trusted Hermes session identity, not model arguments."""
from pathlib import Path
BRIDGE='/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py'
WORKER_TOOLS=frozenset(('vista_receipt_queue','vista_get_receipt','vista_save_reading','vista_receipt_duplicates','vista_find_matches','vista_scan_receipt','vista_drive_sync','vista_receipt_notify','vista_current_time','vista_options','vista_drive_status','vista_receipt_form','vista_receipt_annotate','vista_receipt_checks'))
def bind(config,tool_name,args,session=None):
    if BRIDGE not in config.get('args',[]):return args
    if session is None:
        from gateway.session_context import get_session_env
        session=get_session_env
    result=dict(args)
    if session('HERMES_SESSION_PLATFORM')=='telegram':
        actor=session('HERMES_SESSION_USER_ID')
        if not actor:raise PermissionError('Vista call has no authenticated Telegram actor.')
        if args.get('telegram_user_id') and str(args['telegram_user_id'])!=str(actor):
            raise PermissionError('Identity substitution blocked. Use only the authenticated sender; never retry another user ID.')
        result['telegram_user_id']=str(actor)
    elif session('HERMES_CRON_SESSION')=='1':
        if tool_name not in WORKER_TOOLS:raise PermissionError('Receipt worker cannot perform this business action.')
        if tool_name=='vista_receipt_form':result['show_buttons']=False
        # Existing explicitly owner-authorised background evidence service context.
        result['telegram_user_id']='304348232'
    return result
