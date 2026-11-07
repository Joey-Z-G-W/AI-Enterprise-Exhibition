"""System acceptance against the real Compose UI/API/SQLite stack.

Run after `GUIDE_RELEASE_ID=<sha> docker compose up --build --wait`.
This explicitly recreates only course-demo, preserving its named database volume.
"""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    environment = {**os.environ, 'GUIDE_RELEASE_ID': args.release}
    base = 'http://127.0.0.1:' + environment.get('GUIDE_PORT', '8090')
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def command(*arguments):
        return subprocess.run(arguments, cwd=ROOT, env=environment, text=True,
                              capture_output=True, check=True).stdout.strip()

    def request(path, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        return json.load(opener.open(urllib.request.Request(base + path, data=body,
                         headers={'Content-Type': 'application/json'}), timeout=10))

    def container():
        identifier = command('docker', 'compose', '-p', 'course-demo', 'ps', '-q', 'guide')
        assert identifier, 'Compose guide container exists'
        metadata = json.loads(command('docker', 'inspect', identifier))[0]
        assert metadata['Config']['User'] == '10001:10001', 'Application runs without root'
        assert metadata['State']['Health']['Status'] == 'healthy'
        mounts = [m for m in metadata['Mounts'] if m['Destination'] == '/data']
        assert len(mounts) == 1 and mounts[0]['Type'] == 'volume'
        assert mounts[0]['Name'] == 'course-demo_guide-data', 'SQLite uses the documented named volume'
        return identifier, mounts[0]['Name']

    before_id, before_volume = container()
    assert request('/health') == {'status': 'ok', 'release': args.release}
    visitor = request('/api/session')['visitor_id']
    assert len(cookies) == 1
    question = request('/api/questions', {'request_id': str(uuid.uuid4()),
                       'question': 'How does Aster Pavilion generate power?', 'exhibit_id': 'aster-pavilion'})
    assert question['answer']['status'] == 'supported'
    request('/api/questions/' + question['id'] + '/feedback', {'request_id': str(uuid.uuid4()), 'rating': 5})

    def retained():
        session = request('/api/session')
        assert session['visitor_id'] == visitor, 'The original browser cookie keeps its session'
        row = next(row for row in session['history'] if row['id'] == question['id'])
        assert row['feedback'] == 5 and row['question'] == question['question']
        assert row['answer'] == question['answer'], 'Persisted answer and citations are retained'

    retained()
    command('docker', 'compose', '-p', 'course-demo', 'up', '--force-recreate', '--no-build', '--wait')
    after_id, after_volume = container()
    assert before_id != after_id, 'A new application container was actually created'
    assert before_volume == after_volume, 'Recreation retains the exact database volume'
    assert request('/health') == {'status': 'ok', 'release': args.release}
    retained()
    # A separate browser cookie jar still cannot see the retained visitor history.
    other = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    isolated = json.load(other.open(base + '/api/session', timeout=10))
    assert isolated['visitor_id'] != visitor and isolated['history'] == []
    report = {'status': 'PASS', 'release': args.release, 'volume': before_volume,
              'before_container': before_id, 'after_container': after_id,
              'checks': ['non-root healthy Compose application', 'SQLite question and rating write/read',
                         'actual container recreation', 'same-cookie session/question/feedback/citation persistence',
                         'exact release identity', 'new visitor isolation']}
    evidence = Path(environment.get('GUIDE_TEST_TASK_DIR', str(ROOT / 'docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划'))) / 'evidence/compose-persistence.json'
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
