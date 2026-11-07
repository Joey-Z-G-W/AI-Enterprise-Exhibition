"""Opt-in real Docker/GitHub CLI system acceptance using two verified main releases.

COURSE_RELEASE_RUN_A / COURSE_RELEASE_RUN_B select actual successful push CI runs.
Runs on the dedicated course dev/prod stacks only; preserves all database volumes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import http.cookiejar
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[2]
RUN_A = os.environ.get('COURSE_RELEASE_RUN_A')
RUN_B = os.environ.get('COURSE_RELEASE_RUN_B')
pytestmark = pytest.mark.skipif(not (RUN_A and RUN_B), reason='Requires two actual successful main CI artifacts and authorized local Docker target')


def run(*args):
    return subprocess.run(args, text=True, capture_output=True, check=True).stdout


def test_real_promotion_rollback_persistence_and_failed_candidate():
    state = Path(os.environ.get('COURSE_STATE_DIR', str(Path.home() / '.local/state/exhibition-course')))
    cli = [sys.executable, str(ROOT / 'tools/course_deploy.py'), '--state-dir', str(state)]
    run(*cli, 'deploy', '--run-id', RUN_A)
    run(*cli, 'promote')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request('http://127.0.0.1:8091' + path, data=data, headers={'Content-Type': 'application/json'})
        return json.load(opener.open(req))

    def assert_retained():
        records = request('/api/session')['history']
        retained = next(item for item in records if item['id'] == question_id)
        assert retained['feedback'] == 5
        assert retained['answer']['status'] == 'supported'

    request('/api/session')
    question = request('/api/questions', {'request_id': str(uuid.uuid4()), 'question': 'How does Aster Pavilion generate power?', 'exhibit_id': 'aster-pavilion'})
    question_id = question['id']
    request(f'/api/questions/{question_id}/feedback', {'request_id': str(uuid.uuid4()), 'rating': 5})
    run(*cli, 'deploy', '--run-id', RUN_B)
    run(*cli, 'promote')
    before = json.loads(run(*cli, 'status'))['prod']
    assert before['current']['sha'] != before['previous']['sha'], 'Use two distinct real commits'
    assert_retained()
    run('docker', 'restart', before['current']['container'])
    # CLI promotion polls readiness and verifies the gateway after restart.
    run(*cli, 'promote')
    assert_retained()
    run(*cli, 'rollback', '--environment', 'prod')
    after = json.loads(run(*cli, 'status'))['prod']
    assert after['current']['sha'] == before['previous']['sha']
    assert_retained()
    # Fault injection at the external container boundary, never inside application modules.
    bad = after['previous']
    run('docker', 'rm', '-f', bad['container'])
    run('docker', 'create', '--name', bad['container'], '--health-cmd', 'exit 1', '--health-interval', '1s',
        '--health-retries', '1', bad['image_id'], 'python', '-c', 'import time; time.sleep(180)')
    try:
        failed = subprocess.run([*cli, 'rollback', '--environment', 'prod'], text=True, capture_output=True)
        assert failed.returncode != 0
        assert 'Candidate health/release check failed' in failed.stderr
        assert request('/health')['release'] == after['current']['sha']
        assert_retained()
        assert json.loads(run(*cli, 'status'))['prod']['current']['sha'] == after['current']['sha']
    finally:
        run('docker', 'rm', '-f', bad['container'])
