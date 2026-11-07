"""Optional deployment integration: actual CPU BGE model through HTTP."""
import base64
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import time
import tomllib
import urllib.error
import urllib.request

import pytest

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / '.tools/opentalking-venv/bin/python'
MODEL = 'BAAI/bge-small-zh-v1.5'


@pytest.fixture(scope='module')
def embedding_http(tmp_path_factory):
    if not PYTHON.exists() or not (ROOT / 'models/bge-small-zh-v1.5/pytorch_model.bin').exists():
        pytest.skip('本地模型可选部署尚未安装')
    config = tomllib.loads((ROOT / 'config/local.toml').read_text())['embedding']
    if not config.get('enabled'):
        pytest.skip('本地 embedding 未启用')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    log = tmp_path_factory.mktemp('embedding') / 'server.log'
    with log.open('w+') as output:
        child = subprocess.Popen([str(PYTHON), str(ROOT / 'tools/embedding_server.py')], cwd=ROOT,
                                 env={**os.environ, 'GUIDE_EMBEDDING_PORT': str(port)}, stdout=output, stderr=output)
        try:
            deadline = time.monotonic() + 60
            while True:
                assert child.poll() is None, 'embedding service exited'
                try:
                    with client.open(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                        assert json.load(response)['device'] == 'cpu'
                    break
                except OSError:
                    assert time.monotonic() < deadline, 'embedding startup timeout'
                    time.sleep(.2)
            def post(body, authenticated=True):
                headers = {'Content-Type': 'application/json'}
                if authenticated:
                    headers['Authorization'] = 'Bearer ' + config['api_key']
                request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/embeddings', data=json.dumps(body).encode(), headers=headers)
                with client.open(request, timeout=30) as response:
                    return json.load(response)
            yield post
        finally:
            child.terminate()
            child.wait(timeout=15)
            output.seek(0)
            print(output.read())


def test_real_cpu_embeddings_return_normalized_semantic_vectors(embedding_http):
    result = embedding_http({'model': MODEL, 'input': ['企业提供品牌设计服务。', '公司为客户设计品牌形象。', '今天天气晴朗。']})
    vectors = [row['embedding'] for row in result['data']]
    assert len(vectors) == 3
    for vector in vectors:
        assert len(vector) == 512
        assert abs(sum(x*x for x in vector) - 1) < .0001
        assert all(math.isfinite(x) for x in vector)
    similar = sum(a*b for a, b in zip(vectors[0], vectors[1]))
    unrelated = sum(a*b for a, b in zip(vectors[0], vectors[2]))
    assert similar > unrelated
    assert result['usage']['total_tokens'] > 0


def test_embeddings_support_sdk_base64_format(embedding_http):
    result = embedding_http({'model': MODEL, 'input': '展厅介绍', 'encoding_format': 'base64'})
    assert len(base64.b64decode(result['data'][0]['embedding'])) == 512 * 4


def test_long_text_tail_changes_embedding(embedding_http):
    prefix = '今天的天气晴朗，天空中有几朵白云。' * 70
    endings = ['企业品牌策划与展厅空间设计。' * 60, '细胞生物学和植物基因研究。' * 60]
    result = embedding_http({'model': MODEL, 'input': [prefix + ending for ending in endings]})
    first, second = [row['embedding'] for row in result['data']]
    assert sum((a-b)**2 for a, b in zip(first, second)) > .01


def test_embeddings_reject_unauthorized_and_wrong_model(embedding_http):
    with pytest.raises(urllib.error.HTTPError) as error:
        embedding_http({'model': MODEL, 'input': '展厅介绍'}, authenticated=False)
    assert error.value.code == 401
    with pytest.raises(urllib.error.HTTPError) as error:
        embedding_http({'model': 'unknown', 'input': '展厅介绍'})
    assert error.value.code == 422
