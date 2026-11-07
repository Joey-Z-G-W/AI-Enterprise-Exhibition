"""HTTP integration tests against the real demo app, sample catalog and SQLite."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
import sqlite3

from exhibition_guide.demo import create_demo_app


@pytest.fixture
def configured(monkeypatch, tmp_path):
    monkeypatch.setenv('GUIDE_DEMO_DB', str(tmp_path / 'guide.sqlite3'))
    monkeypatch.setenv('GUIDE_RELEASE_ID', 'integration-release')
    monkeypatch.setenv('GUIDE_DEMO_COOKIE_NAME', 'guide_test_visitor')
    monkeypatch.delenv('GUIDE_STATIC_DIR', raising=False)
    return tmp_path


def question(client, text='How does Aster Pavilion generate power?', **extra):
    return client.post('/api/questions', json={'request_id': str(uuid4()), 'question': text, **extra})


def test_catalog_public_cases_and_health(configured):
    with TestClient(create_demo_app()) as client:
        assert client.get('/health').json() == {'status': 'ok', 'release': 'integration-release'}
        catalog = client.get('/api/exhibits').json()
        assert catalog['mode'] == 'local-sample-retrieval'
        assert catalog['license']['id'] == 'CC0-1.0'
        assert len(catalog['sha256']) == 64
        assert len(catalog['exhibits']) == 3
        client.get('/api/session')
        for case in catalog['examples']:
            payload = {'request_id': str(uuid4()), 'question': case['question']}
            if case.get('exhibit_id'):
                payload['exhibit_id'] = case['exhibit_id']
            response = client.post('/api/questions', json=payload)
            assert response.status_code == 201, response.text
            result = response.json()['answer']
            assert result['status'] == case['expected_status']
            if result['status'] == 'supported':
                assert result['citations']
                assert all(c['excerpt'] and c['fact_id'] and c['sha256'] == catalog['sha256'] for c in result['citations'])
            if result['status'] == 'conflicting':
                assert len(result['citations']) == 2


def test_real_sqlite_history_feedback_survive_new_application(configured):
    with TestClient(create_demo_app()) as first:
        session = first.get('/api/session')
        assert session.json()['history'] == []
        assert 'HttpOnly' in session.headers['set-cookie']
        assert 'SameSite=strict' in session.headers['set-cookie']
        response = question(first)
        assert response.status_code == 201
        record = response.json()
        feedback = {'request_id': str(uuid4()), 'rating': 5}
        assert first.post(f"/api/questions/{record['id']}/feedback", json=feedback).status_code == 200
        cookies = dict(first.cookies)
        visitor_id = session.json()['visitor_id']
    assert (configured / 'guide.sqlite3').is_file()
    with TestClient(create_demo_app()) as restarted:
        restarted.cookies.update(cookies)
        state = restarted.get('/api/session').json()
        assert state['visitor_id'] == visitor_id
        assert len(state['history']) == 1
        assert state['history'][0]['id'] == record['id']
        assert state['history'][0]['feedback'] == 5
        assert state['history'][0]['answer']['citations']


def test_cookie_isolation_clear_history_and_new_visitor(configured):
    app = create_demo_app()
    with TestClient(app) as alice, TestClient(app) as bob:
        alice_id = alice.get('/api/session').json()['visitor_id']
        record = question(alice).json()
        bob.get('/api/session')
        assert bob.get('/api/session').json()['history'] == []
        forbidden = bob.post(f"/api/questions/{record['id']}/feedback", json={'request_id': str(uuid4()), 'rating': 1})
        assert forbidden.status_code == 404
        assert bob.delete('/api/history').status_code == 200
        assert len(alice.get('/api/session').json()['history']) == 1
        assert alice.delete('/api/history').json() == {'deleted': 1}
        assert alice.get('/api/session').json()['history'] == []
        question(alice)
        retired_cookie = dict(alice.cookies)
        result = alice.post('/api/visitors/new')
        assert result.status_code == 200
        assert result.json()['visitor_id'] != alice_id
        assert result.json()['history'] == []
        alice.cookies.clear()
        alice.cookies.update(retired_cookie)
        assert question(alice).status_code == 401


def test_submission_and_feedback_retries_are_idempotent(configured):
    with TestClient(create_demo_app()) as client:
        client.get('/api/session')
        payload = {'request_id': str(uuid4()), 'question': 'How does Aster Pavilion generate power?'}
        first = client.post('/api/questions', json=payload)
        again = client.post('/api/questions', json=payload)
        assert again.json() == first.json()
        assert len(client.get('/api/session').json()['history']) == 1
        assert client.post('/api/questions', json={**payload, 'question': 'different'}).status_code == 409
        url = f"/api/questions/{first.json()['id']}/feedback"
        rating = {'request_id': str(uuid4()), 'rating': 4}
        assert client.post(url, json=rating).json() == client.post(url, json=rating).json()
        assert client.post(url, json={**rating, 'rating': 2}).status_code == 409
        client.delete('/api/history')
        assert client.post('/api/questions', json=payload).status_code == 409
        assert client.get('/api/session').json()['history'] == []
    # Storage is an external integration boundary: cleared payloads must not remain queryable.
    with sqlite3.connect(configured / 'guide.sqlite3') as database:
        assert database.execute('SELECT COUNT(*) FROM questions').fetchone()[0] == 0
        assert all(row[0] == '{}' for row in database.execute('SELECT response FROM operations'))


def test_concurrent_duplicate_requests_create_one_record(configured):
    with TestClient(create_demo_app()) as client:
        client.get('/api/session')
        body = {'request_id': str(uuid4()), 'question': 'How does Aster Pavilion generate power?'}
        with ThreadPoolExecutor(max_workers=4) as pool:
            replies = list(pool.map(lambda _: client.post('/api/questions', json=body), range(4)))
        assert all(r.status_code == 201 for r in replies)
        assert len({r.json()['id'] for r in replies}) == 1
        assert len(client.get('/api/session').json()['history']) == 1


@pytest.mark.parametrize('change', [{'question': ''}, {'question': '   '}, {'question': 'x' * 2001}, {'question': 42}, {'request_id': 'bad'}, {'exhibit_id': 'missing'}, {'surprise': 'ignored?'}])
def test_question_validation(configured, change):
    with TestClient(create_demo_app()) as client:
        client.get('/api/session')
        response = client.post('/api/questions', json={'request_id': str(uuid4()), 'question': 'power', **change})
        assert response.status_code == 422
        assert client.get('/api/session').json()['history'] == []


@pytest.mark.parametrize('rating', [0, 6, -1, 1.5, True, '5', None])
def test_feedback_validation(configured, rating):
    with TestClient(create_demo_app()) as client:
        client.get('/api/session')
        record = question(client).json()
        response = client.post(f"/api/questions/{record['id']}/feedback", json={'request_id': str(uuid4()), 'rating': rating})
        assert response.status_code == 422
        assert client.get('/api/session').json()['history'][0]['feedback'] is None


def test_malformed_input_unauthorized_and_cross_origin(configured):
    with TestClient(create_demo_app()) as client:
        assert question(client).status_code == 401
        client.get('/api/session')
        bad = client.post('/api/questions', content='{"private_input": secret-value', headers={'content-type': 'application/json'})
        assert bad.status_code == 422
        assert 'secret-value' not in bad.text
        body = {'request_id': str(uuid4()), 'question': 'power'}
        for method, url, kwargs in [('post', '/api/questions', {'json': body}), ('delete', '/api/history', {}), ('post', '/api/visitors/new', {})]:
            response = getattr(client, method)(url, headers={'origin': 'https://untrusted.example'}, **kwargs)
            assert response.status_code == 403
        assert client.get('/api/session').json()['history'] == []


def test_frontend_static_and_api_routes_do_not_overlap(configured, monkeypatch):
    static = configured / 'frontend'
    static.mkdir()
    (static / 'index.html').write_text('<html>sample guide</html>')
    (static / 'asset.js').write_text('sample asset')
    monkeypatch.setenv('GUIDE_STATIC_DIR', str(static))
    with TestClient(create_demo_app()) as client:
        assert client.get('/').text == '<html>sample guide</html>'
        assert client.get('/guide/history').text == '<html>sample guide</html>'
        assert client.get('/asset.js').text == 'sample asset'
        assert client.get('/api/missing').status_code == 404
        assert client.get('/api/session').headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('origin', ['http://[bad', 'null', 'not-an-origin', 'https://untrusted.example'])
def test_invalid_or_foreign_origin_is_rejected_without_server_error(configured, origin):
    with TestClient(create_demo_app(), raise_server_exceptions=False) as client:
        client.get('/api/session')
        response = client.post('/api/questions', headers={'origin': origin}, json={
            'request_id': str(uuid4()), 'question': 'How does Aster Pavilion generate power?',
        })
        assert response.status_code == 403
        assert response.json() == {'detail': 'Cross-origin requests are not allowed.'}
        assert client.get('/api/session').json()['history'] == []
