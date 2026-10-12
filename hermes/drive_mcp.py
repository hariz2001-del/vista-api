#!/usr/bin/env python3
"""Separate Finances MCP session: Google failures and Vista failures stay isolated.

Shares protocol/credential helpers, not Vista's RPC connection or breaker.
Only the direct Drive tool is exposed or executable on this server.
"""
import json
import sys
import vista_mcp as m
m.TOOLS = [m.DIRECT_DRIVE_TOOL]

def handle(message):
    ident = message.get('id')
    if message.get('method') == 'tools/call' and (message.get('params') or {}).get('name') != 'chopper_drive':
        m._send({'jsonrpc':'2.0','id':ident,'result':{'isError':True,'content':[{'type':'text','text':'This connection only supports chopper_drive. Use the independent Vista connection for database tools.'}]}})
        return
    m._handle(message)

if __name__ == '__main__':
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        handle(message)
