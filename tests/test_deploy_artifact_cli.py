"""CLI integration: real TLS/API redirect/range server; only external gh is substituted."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import socketserver
import ssl
import subprocess
import sys
import threading
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40
REPO = 'Joey-Z-G-W/AI-Enterprise-Exhibition'


@pytest.fixture
def artifact_service(tmp_path):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as bundle:
        bundle.writestr('image.tar', os.urandom(1100000))
        bundle.writestr('manifest.json', '{"image":"interface-fixture"}')
    state = {'archive': archive.getvalue(), 'mode': 'success', 'api_auth': [], 'blob_auth': [], 'ranges': []}
    certificate, key = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:api.github.com',
                    '-keyout', str(key), '-out', str(certificate)], check=True, capture_output=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)

    class Blob(BaseHTTPRequestHandler):
        def do_GET(self):
            state['blob_auth'].append(self.headers.get('Authorization'))
            first, last = map(int, self.headers['Range'].removeprefix('bytes=').split('-'))
            state['ranges'].append((first, last))
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {first + (state["mode"] == "bad-range")}-{last}/{len(state["archive"])}')
            data = state['archive'][first:last + 1]
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    blob = ThreadingHTTPServer(('127.0.0.1', 0), Blob)
    blob.socket = context.wrap_socket(blob.socket, server_side=True)

    class APIProxy(socketserver.StreamRequestHandler):
        def handle(self):
            assert self.rfile.readline().startswith(b'CONNECT api.github.com:443 ')
            while self.rfile.readline().strip():
                pass
            self.wfile.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
            self.wfile.flush()
            with context.wrap_socket(self.connection, server_side=True) as stream:
                reader = stream.makefile('rb')
                assert reader.readline().startswith(b'GET /repos/' + REPO.encode() + b'/actions/artifacts/202/zip ')
                headers = {}
                while line := reader.readline().strip():
                    name, value = line.decode().split(':', 1)
                    headers[name.lower()] = value.strip()
                state['api_auth'].append(headers.get('authorization'))
                location = f'https://localhost:{blob.server_port}/archive?signature=DO_NOT_LOG_SIGNED_SECRET'
                stream.sendall(f'HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'.encode())

    proxy = socketserver.ThreadingTCPServer(('127.0.0.1', 0), APIProxy)
    for server in (blob, proxy):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    metadata = tmp_path / 'metadata.json'
    token = 'DO_NOT_LOG_TEST_TOKEN'
    gh = tmp_path / 'gh'
    gh.write_text(f'''#!{sys.executable}
import json,os,sys
if sys.argv[1:] == ['auth','token','--hostname','github.com']: print('{token}')
else:
 data=json.load(open(os.environ['ARTIFACT_FIXTURE_METADATA']))
 print(json.dumps(data['artifacts'] if '/artifacts?' in sys.argv[-1] else data['run']))
''')
    gh.chmod(0o755)
    environment = {key: value for key, value in os.environ.items() if key.lower() not in ('https_proxy', 'http_proxy', 'all_proxy', 'no_proxy')}
    environment.update(PATH=str(tmp_path) + os.pathsep + environment['PATH'], SSL_CERT_FILE=str(certificate),
                       HTTPS_PROXY=f'http://127.0.0.1:{proxy.server_address[1]}', NO_PROXY='localhost,127.0.0.1',
                       ARTIFACT_FIXTURE_METADATA=str(metadata))

    def invoke(output, *, event='push', digest=None, deployment=False):
        metadata.write_text(json.dumps({'run': {'id': 101, 'event': event, 'head_branch': 'main', 'head_sha': SHA,
            'path': '.github/workflows/ci.yml', 'status': 'completed', 'conclusion': 'success',
            'head_repository': {'id': 303, 'full_name': REPO}, 'repository': {'id': 303}},
            'artifacts': {'artifacts': [{'id': 202, 'name': f'course-image-{SHA}', 'expired': False,
                'digest': 'sha256:' + (digest or hashlib.sha256(state['archive']).hexdigest()),
                'size_in_bytes': len(state['archive']), 'workflow_run': {'id': 101, 'head_sha': SHA,
                    'head_branch': 'main', 'repository_id': 303, 'head_repository_id': 303}}]}}))
        arguments = ([sys.executable, str(ROOT / 'tools/course_deploy.py'), '--state-dir', str(output), 'deploy', '--run-id', '101']
                     if deployment else [sys.executable, str(ROOT / 'tools/course_artifact.py'), '--run-id', '101', '--sha', SHA, '--output', str(output)])
        result = subprocess.run(arguments, env=environment, capture_output=True,
                                text=True, timeout=30)
        assert token not in result.stdout + result.stderr
        assert 'DO_NOT_LOG_SIGNED_SECRET' not in result.stdout + result.stderr
        return result

    yield state, invoke
    for server in (blob, proxy):
        server.shutdown()
        server.server_close()


def test_real_tls_range_download_and_atomic_complete_cache(artifact_service, tmp_path):
    state, invoke = artifact_service
    destination = tmp_path / 'cache'
    result = invoke(destination)
    assert result.returncode == 0, result.stderr
    assert set(p.name for p in destination.iterdir()) == {'image.tar', 'manifest.json', 'verified-artifact.json'}
    assert (destination / 'image.tar').stat().st_size == 1100000
    assert state['api_auth'] == ['Bearer DO_NOT_LOG_TEST_TOKEN']
    assert state['blob_auth'] and all(value is None for value in state['blob_auth'])
    assert len(state['ranges']) == 3  # One probe and two complete disjoint blocks.
    assert invoke(destination).returncode == 0
    assert len(state['ranges']) == 3, 'A verified complete cache does not redownload'


@pytest.mark.parametrize('failure', ['bad-range', 'bad-digest', 'unsafe-zip'])
def test_invalid_external_artifact_never_publishes_cache(artifact_service, tmp_path, failure):
    state, invoke = artifact_service
    if failure == 'bad-range':
        state['mode'] = failure
    if failure == 'unsafe-zip':
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('../escape', b'unsafe')
            bundle.writestr('manifest.json', '{}')
        state['archive'] = archive.getvalue()
    destination = tmp_path / 'cache'
    result = invoke(destination, digest='0' * 64 if failure == 'bad-digest' else None)
    assert result.returncode != 0
    assert not destination.exists()
    assert not (tmp_path / 'escape').exists()
    assert not list(tmp_path.glob('.101-*')), 'Failed transfers clean their staging directory'


def test_failed_replacement_preserves_previous_complete_cache(artifact_service, tmp_path):
    _, invoke = artifact_service
    destination = tmp_path / 'cache'
    assert invoke(destination).returncode == 0
    previous = {p.name: p.read_bytes() for p in destination.iterdir()}
    assert invoke(destination, digest='0' * 64).returncode != 0
    assert {p.name: p.read_bytes() for p in destination.iterdir()} == previous


def test_controller_rejects_pr_before_any_artifact_download(artifact_service, tmp_path):
    state, invoke = artifact_service
    result = invoke(tmp_path / 'controller-state', event='pull_request', deployment=True)
    assert result.returncode != 0
    assert 'push/main Course CI' in result.stderr
    assert not state['api_auth'] and not state['ranges']


def test_symlink_to_verified_cache_is_rejected(artifact_service, tmp_path):
    state, invoke = artifact_service
    real = tmp_path / 'verified-cache'
    assert invoke(real).returncode == 0
    link = tmp_path / 'symlink-cache'
    link.symlink_to(real, target_is_directory=True)
    result = invoke(link)
    assert result.returncode != 0 and 'not a directory' in result.stderr
    assert len(state['ranges']) == 3
    assert (real / 'image.tar').is_file()
