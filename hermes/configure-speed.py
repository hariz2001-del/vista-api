"""Scoped, recoverable profile-only model/latency configuration."""
import argparse, copy, shutil
from pathlib import Path
import yaml
HOME=Path('/home/ubuntu/.hermes/profiles/sarangbooks')
def configure(original,model):
    updated=copy.deepcopy(original)
    updated.setdefault('model',{})['default']=model
    updated.setdefault('agent',{})['reasoning_effort']='low'
    # This bot has one known Vista MCP. Eager schemas remove search/describe
    # round trips; this does NOT enable new tools or broaden permissions.
    updated.setdefault('tools',{}).setdefault('tool_search',{})['enabled']='off'
    assert updated.get('platform_toolsets')==original.get('platform_toolsets')
    assert updated.get('mcp_servers')==original.get('mcp_servers')
    assert updated.get('model',{}).get('provider')==original.get('model',{}).get('provider')
    return updated
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--model',choices=['gpt-6-luna','gpt-5.6-terra','gpt-6.1-sol'],default='gpt-6-luna');args=parser.parse_args()
    path=HOME/'config.yaml';original=yaml.safe_load(path.read_text())
    backup=path.with_name('config.yaml.before-speed-v1')
    if not backup.exists():shutil.copy2(path,backup)
    path.write_text(yaml.safe_dump(configure(original,args.model),sort_keys=False,allow_unicode=True))
    print('Sarangbooks only: model='+args.model+', reasoning=low, direct Vista tools. Gateway reload required. Other profiles and credentials unchanged.')
