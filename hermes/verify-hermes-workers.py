"""Read-only installed-Hermes transport verification, no Google/Vista RPC."""
import asyncio
import sys
from types import SimpleNamespace
sys.path.insert(0, '/home/ubuntu/.hermes/hermes-agent')
import hermes_bootstrap
sys.path.insert(0, '/home/ubuntu/.hermes/profiles/sarangbooks/integrations')
from agent.delegation_context import delegated_child_context
from gateway.session_context import set_session_vars, clear_session_vars
from tools.mcp_tool_handlers import _call_tool_racing_stdio_death

class Session:
    calls = 0
    async def call_tool(self, name, arguments):
        self.calls += 1
        return arguments

async def main():
    tokens = set_session_vars(platform='telegram', user_id='304348232')
    try:
        for bridge, server_name, tool in [('vista_mcp.py', 'vista', 'vista_post'), ('drive_mcp.py', 'finances_drive', 'chopper_drive')]:
            rpc = Session()
            server = SimpleNamespace(_config={'args': ['/home/ubuntu/.hermes/profiles/sarangbooks/integrations/' + bridge]}, session=rpc)
            with delegated_child_context('test-child'):
                try:
                    await _call_tool_racing_stdio_death(server, server_name, tool, {'telegram_user_id': '304348232'})
                except PermissionError:
                    pass
                else:
                    raise AssertionError('Child call reached financial RPC')
            assert rpc.calls == 0
            allowed = await _call_tool_racing_stdio_death(server, server_name, 'vista_sales' if server_name == 'vista' else tool, {})
            assert allowed['telegram_user_id'] == '304348232'
            assert rpc.calls == 1
        print('PASS actual Hermes delegate context: child Vista/Drive calls denied before RPC; parent actor binding preserved.')
    finally:
        clear_session_vars(tokens)

asyncio.run(main())
