"""Minimal scoped transport hook; restore .before-vista-actor to roll back."""
from pathlib import Path
import shutil
target=Path('/home/ubuntu/.hermes/hermes-agent/tools/mcp_tool_handlers.py')
text=target.read_text()
if 'VISTA_ACTOR_GUARD_V1' not in text:
    anchor='    _call_coro = server.session.call_tool(tool_name, arguments=args)\n'
    if text.count(anchor)!=1:raise SystemExit('MCP anchor changed; inspect instead of guessing.')
    backup=target.with_suffix('.py.before-vista-actor')
    if not backup.exists():shutil.copy2(target,backup)
    hook="""    # VISTA_ACTOR_GUARD_V1: only the explicitly configured finance bridge
    if '/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py' in getattr(server, '_config', {}).get('args', []):
        import importlib.util
        _vista_actor_spec = importlib.util.spec_from_file_location('vista_actor_guard', '/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_actor_guard.py')
        _vista_actor = importlib.util.module_from_spec(_vista_actor_spec)
        _vista_actor_spec.loader.exec_module(_vista_actor)
        args = _vista_actor.bind(server._config, tool_name, args)
"""
    text=text.replace(anchor,hook+anchor);compile(text,str(target),'exec');target.write_text(text)
print('Vista session actor and evidence-only worker guard installed; other MCP connections unchanged.')
if 'CHOPPER_DRIVE_ACTOR_GUARD_V1' not in text:
    anchor="    if '/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py' in getattr(server, '_config', {}).get('args', []):"
    if text.count(anchor)!=1:raise SystemExit('Independent Drive actor anchor changed; inspect first.')
    replacement="    # CHOPPER_DRIVE_ACTOR_GUARD_V1\n    if any(_path in getattr(server, '_config', {}).get('args', []) for _path in ('/home/ubuntu/.hermes/profiles/sarangbooks/integrations/vista_mcp.py', '/home/ubuntu/.hermes/profiles/sarangbooks/integrations/drive_mcp.py')):"
    text=text.replace(anchor,replacement);compile(text,str(target),'exec');target.write_text(text)
print('Both independent finance MCP connections bind the real session actor before RPC.')
