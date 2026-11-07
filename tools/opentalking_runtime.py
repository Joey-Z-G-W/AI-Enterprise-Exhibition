"""Pass locally configured providers to OpenTalking without printing secrets."""
from pathlib import Path
import os
import runpy
import sys
import tomllib

root = Path(__file__).resolve().parents[1]
config = tomllib.loads((root / 'config/local.toml').read_text())
llm, embedding = config['llm'], config['embedding']
if llm.get('enabled'):
    for field in ('base_url', 'api_key', 'model'):
        os.environ.setdefault('OPENTALKING_LLM_' + field.upper(), str(llm[field]))
        os.environ.setdefault('OPENTALKING_AGENT_LIGHTRAG_LLM_' + field.upper(), str(llm[field]))
if embedding.get('enabled'):
    for field in ('base_url', 'api_key', 'model'):
        os.environ.setdefault('OPENTALKING_AGENT_LIGHTRAG_EMBEDDING_' + field.upper(), str(embedding[field]))
    os.environ.setdefault('OPENTALKING_AGENT_LIGHTRAG_EMBEDDING_DIM', str(embedding['dimensions']))
sys.argv = ['opentalking-unified', '--host', '127.0.0.1', '--port', '8210']
runpy.run_module('apps.unified.main', run_name='__main__')
