"""Loopback OpenAI-compatible BGE embeddings, using local weights on CPU."""
from contextlib import asynccontextmanager
from pathlib import Path
import base64
import os
import secrets
import threading
import tomllib
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
import torch
from transformers import AutoModel, AutoTokenizer
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'BAAI/bge-small-zh-v1.5'


class EmbeddingRequest(BaseModel):
    model: Literal['BAAI/bge-small-zh-v1.5'] = MODEL
    input: str | list[str]
    encoding_format: Literal['float', 'base64'] = 'float'
    dimensions: Literal[512] = 512


@asynccontextmanager
async def lifespan(app):
    config = tomllib.loads((ROOT / 'config/local.toml').read_text())['embedding']
    if not config.get('enabled') or not config.get('api_key'):
        raise RuntimeError('请在 config/local.toml 配置本地 embedding')
    app.state.key = config['api_key']
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model_dir = ROOT / 'models/bge-small-zh-v1.5'
    app.state.tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    app.state.model = AutoModel.from_pretrained(model_dir, local_files_only=True).eval().to('cpu')
    app.state.lock = threading.Lock()
    yield


app = FastAPI(title='Local BGE Embeddings', lifespan=lifespan)


@app.get('/health')
def health():
    return {'status': 'ok', 'model': MODEL, 'device': 'cpu', 'dimensions': 512}


@app.post('/v1/embeddings')
def embeddings(body: EmbeddingRequest, authorization: str = Header(default='')):
    if not secrets.compare_digest(authorization, 'Bearer ' + app.state.key):
        raise HTTPException(401, 'invalid local embedding token')
    texts = [body.input] if isinstance(body.input, str) else body.input
    if not 1 <= len(texts) <= 64 or any(not s.strip() or len(s) > 32000 for s in texts):
        raise HTTPException(400, 'expected 1–64 nonempty texts, each at most 32000 characters')
    data, tokens = [], 0
    # Cover the complete text with overlapping model windows. Only a bounded
    # window batch enters BERT, and normalized CLS vectors are pooled per input.
    with app.state.lock, torch.inference_mode():
        for start in range(0, len(texts), 8):
            batch = texts[start:start + 8]
            encoded = app.state.tokenizer(batch, padding=True, truncation=True, max_length=512,
                                          stride=64, return_overflowing_tokens=True, return_tensors='pt')
            owners = encoded.pop('overflow_to_sample_mapping')
            pooled = torch.zeros((len(batch), 512))
            for offset in range(0, len(owners), 8):
                window = {key: value[offset:offset + 8] for key, value in encoded.items()}
                values = app.state.model(**window).last_hidden_state[:, 0]
                values = torch.nn.functional.normalize(values, p=2, dim=1).float()
                weights = window['attention_mask'].sum(dim=1).float()
                pooled.index_add_(0, owners[offset:offset + 8], values * weights[:, None])
                tokens += int(weights.sum())
            vectors = torch.nn.functional.normalize(pooled, p=2, dim=1).numpy()
            for vector in vectors:
                embedding = (base64.b64encode(vector.astype('<f4').tobytes()).decode()
                             if body.encoding_format == 'base64' else vector.tolist())
                data.append({'object': 'embedding', 'index': len(data), 'embedding': embedding})
    return {'object': 'list', 'model': MODEL, 'data': data, 'usage': {'prompt_tokens': tokens, 'total_tokens': tokens}}


if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('GUIDE_EMBEDDING_PORT', '8220')))
