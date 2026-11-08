"""Conversation invariants through HTTP, real history/answer/SDK/knowledge assembly."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient
from exhibition_guide.config import AppConfig, ModelConfig, KnowledgeConfig
from exhibition_guide.main import create_app
from test_concise_answer_http import external_services, application_client, question, completion, SHORT


@pytest.mark.parametrize('text', ['你好', ' 您好！ ', 'HELLO!', '谢谢', '再见', '你好吗？', '你是谁？'])
def test_social_turns_are_unsourced_and_do_not_call_external_services(application_client, external_services, text):
    response = question(application_client, text)
    assert response.status_code == 200
    assert response.json()['text'] and response.json()['sources'] == []
    assert external_services['queries'] == external_services['completions'] == []


@pytest.mark.parametrize('verdict', ['insufficient', 'conflicting'])
def test_uncertainty_still_rejects_forged_evidence(application_client, external_services, verdict):
    external_services['replies'] = [(completion(verdict=verdict, excerpt='伪造原文'), 'stop')]
    response = question(application_client)
    assert response.status_code == 502
    assert response.json()['error_code'] == 'invalid_model_response'


def test_social_and_unknown_turns_never_replace_grounded_history(application_client, external_services):
    external_services['replies'] = [(completion(), 'stop')]
    assert question(application_client).status_code == 200
    assert question(application_client, '谢谢', seq=2).status_code == 200
    external_services['replies'] = [({'verdict':'resolved','question':'固定报价？'}, 'stop'),
        (completion(verdict='insufficient', excerpt=None), 'stop'),
        ({'verdict':'resolved','question':'青山展馆何时闭馆？'}, 'stop'), (completion(), 'stop')]
    assert question(application_client, '谢谢，你们保证30天吗？', seq=3).json()['sources'] == []
    assert question(application_client, '它何时闭馆？', seq=4).status_code == 200
    rewrites = [json.loads(w['messages'][1]['content']) for w in external_services['completions']]
    histories = [w['history'] for w in rewrites if 'history' in w]
    assert len(histories) == 2
    assert histories[0] == histories[1] == [{'question':'青山展馆的开放时间是什么？','answer':SHORT}]


def test_inflight_and_completed_duplicates_share_one_answer(application_client, external_services):
    gate = {'path':'/chat/completions', 'entered':Event(), 'release':Event()}
    external_services.update(gate=gate, replies=[(completion(), 'stop')])
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(question, application_client)
        try:
            assert gate['entered'].wait(3)
            duplicate = pool.submit(question, application_client)
            conflict = question(application_client, '不同问题')
            assert conflict.status_code == 409 and conflict.json()['error_code'] == 'turn_conflict'
        finally:
            gate['release'].set()
        original = first.result(timeout=5)
        assert original.status_code == 200
        assert duplicate.result(timeout=5).json() == original.json()
    assert question(application_client).json() == original.json()
    assert len(external_services['completions']) == len(external_services['queries']) == 1


@pytest.mark.parametrize('operation', ['invalidate', 'retire', 'newer'])
def test_cancelled_late_external_answer_cannot_pollute_history(application_client, external_services, operation):
    gate = {'path':'/chat/completions', 'entered':Event(), 'release':Event()}
    external_services.update(gate=gate, replies=[(completion(), 'stop')])
    with ThreadPoolExecutor(1) as pool:
        pending = pool.submit(question, application_client)
        try:
            assert gate['entered'].wait(3)
            if operation == 'newer':
                assert question(application_client, '你好', seq=2).status_code == 200
            else:
                result = application_client.post('/visitors/http-brevity-visitor/invalidate', json={'through_turn_seq':1, 'retire':operation == 'retire'})
                assert result.status_code == 200
            cancelled = pending.result(timeout=3)
            assert cancelled.status_code == 409 and cancelled.json()['error_code'] == 'turn_cancelled'
        finally:
            gate['release'].set()
    # An independent visitor succeeds while the cancelled visitor remains invalidated.
    external_services.pop('gate')
    external_services['replies'].append((completion(), 'stop'))
    assert question(application_client, visitor='independent').status_code == 200
    if operation == 'retire':
        assert question(application_client, seq=3).json()['error_code'] == 'visitor_retired'
    else:
        external_services['replies'].append((completion(), 'stop'))
        assert question(application_client, seq=3).status_code == 200
        assert all('history' not in json.loads(w['messages'][1]['content']) for w in external_services['completions'])


@pytest.mark.parametrize('seq', [0, -1, True, '1', 1.5, 9007199254740992])
def test_invalid_turn_sequence_rejected_at_http_boundary(application_client, seq):
    assert question(application_client, seq=seq).status_code == 422


def test_watermark_never_regresses_and_retired_visitors_count_toward_capacity(application_client):
    url = '/visitors/http-brevity-visitor/invalidate'
    assert application_client.post(url, json={'through_turn_seq':10}).json()['cancelled_through'] == 10
    assert application_client.post(url, json={'through_turn_seq':2}).json()['cancelled_through'] == 10
    assert question(application_client, '你好', seq=9).json()['error_code'] == 'turn_stale'
    for i in range(63):
        assert application_client.post(f'/visitors/retired-{i}/invalidate', json={'through_turn_seq':0,'retire':True}).status_code == 200
    result = question(application_client, '你好', visitor='overflow')
    assert result.status_code == 429 and result.json()['error_code'] == 'visitor_capacity'
    assert application_client.post('/visitors/overflow/invalidate', json={'through_turn_seq':1}).status_code == 429


@pytest.mark.parametrize('path,expected', [('/chat/completions','model_service_unavailable'), ('/agent/knowledge-bases/offline-kb/lightrag/query','retrieval_http_error')])
def test_external_http_errors_are_safe(application_client, external_services, path, expected):
    external_services.update(failure_path=path, failure_status=503)
    response = question(application_client)
    assert response.status_code == 502
    assert response.json()['status'] == 'error' and response.json()['sources'] == []
    assert response.json()['error_code'] == expected
    assert 'fixture-private-secret' not in response.text


@pytest.mark.parametrize('file_bytes', [b'changed file', b'\xff\xfe'])
def test_unverified_document_bytes_never_reach_model(application_client, external_services, file_bytes):
    external_services['file_bytes'] = file_bytes
    response = question(application_client)
    assert response.status_code == 502
    assert response.json()['sources'] == [] and external_services['completions'] == []


def test_total_deadline_returns_error_and_next_visitor_can_answer(external_services):
    external_services['delays'] = {'/chat/completions':.4}
    external_services['replies'] = [(completion(), 'stop'), (completion(), 'stop')]
    config = AppConfig(llm=ModelConfig(enabled=True, base_url=external_services['url'], api_key='fixture', timeout_seconds=.15),
                       knowledge=KnowledgeConfig(base_url=external_services['url'], kb_id='offline-kb'))
    with TestClient(create_app(config)) as client:
        result = question(client)
        assert result.status_code == 504 and result.json()['error_code'] == 'model_timeout'
        external_services['delays'] = {}
        assert question(client, visitor='next').status_code == 200
