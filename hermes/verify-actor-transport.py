"""Exercise the installed Hermes transport hook with isolated concurrent RPCs."""
import asyncio, os, sys
from types import SimpleNamespace
sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
from gateway.session_context import set_session_vars, clear_session_vars
from tools.mcp_tool_handlers import _call_tool_racing_stdio_death
BRIDGE='/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py'
class Session:
    async def call_tool(self,name,arguments):
        await asyncio.sleep(0.001)
        return arguments
server=SimpleNamespace(_config={'args':[BRIDGE]},session=Session())
async def actor(user):
    tokens=set_session_vars(platform='telegram',user_id=user)
    try:
        result=await _call_tool_racing_stdio_death(server,'vista','vista_operations',{})
        assert result['telegram_user_id']==user
        try:await _call_tool_racing_stdio_death(server,'vista','vista_operations',{'telegram_user_id':'304348232'})
        except PermissionError:pass
        else:raise AssertionError('Impersonation reached RPC')
    finally:clear_session_vars(tokens)
async def main():
    await asyncio.gather(actor('viewer-one'),actor('viewer-two'))
    tokens=set_session_vars(source='cron',cron_session='1')
    try:
        try:await _call_tool_racing_stdio_death(server,'vista','vista_post',{})
        except PermissionError:pass
        else:raise AssertionError('Worker posting reached RPC')
        assert (await _call_tool_racing_stdio_death(server,'vista','vista_get_receipt',{}))['telegram_user_id']=='304348232'
    finally:clear_session_vars(tokens)
    print('PASS installed transport: concurrent actors isolated, substituted identity blocked before RPC, worker posting blocked, evidence reads allowed.')
    direct=SimpleNamespace(_config={'args':['/home/ubuntu/.hermes/profiles/sarangbooks/integrations/drive_mcp.py']},session=Session())
    tokens=set_session_vars(platform='telegram',user_id='viewer-one')
    try:
        assert (await _call_tool_racing_stdio_death(direct,'finances_drive','chopper_drive',{'action':'status'}))['telegram_user_id']=='viewer-one'
        try:await _call_tool_racing_stdio_death(direct,'finances_drive','chopper_drive',{'action':'preview','telegram_user_id':'304348232'})
        except PermissionError:pass
        else:raise AssertionError('Independent Drive identity substitution reached RPC')
    finally:clear_session_vars(tokens)
    print('PASS separate Drive transport: actor bound; owner impersonation blocked before independent RPC.')
asyncio.run(main())
