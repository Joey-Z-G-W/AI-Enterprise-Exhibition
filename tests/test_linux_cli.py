"""CLI integration: real launcher, Vite proxy and Python HTTP application."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.request
import json

import pytest

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / 'tools/linux.sh'


def port_is_open(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


def test_linux_cli_rejects_unknown_command():
    result = subprocess.run(['bash', str(CLI), 'unknown'], capture_output=True, text=True)
    assert result.returncode == 2
    assert '用法' in result.stderr


def test_linux_cli_refuses_occupied_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        sock.listen()
        env = {**os.environ, 'GUIDE_FRONTEND_PORT': str(sock.getsockname()[1])}
        result = subprocess.run(['bash', str(CLI), 'dev'], env=env, capture_output=True, text=True, timeout=15)
        assert result.returncode != 0
        assert '端口已占用' in result.stderr


@pytest.mark.parametrize('stop_signal', [signal.SIGTERM, signal.SIGINT])
def test_linux_cli_starts_proxy_and_cleans_up(tmp_path, stop_signal):
    port = next((p for p in [8011, 8010] if not port_is_open(p)), None)
    assert port, 'Both backend ports are already occupied'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        frontend = sock.getsockname()[1]
    env = {**os.environ, 'GUIDE_BUSINESS_PORT': str(port), 'GUIDE_FRONTEND_PORT': str(frontend)}
    with (tmp_path / 'launcher.log').open('w+') as output:
        child = subprocess.Popen(['bash', str(CLI), 'dev'], cwd=tmp_path, env=env, stdout=output, stderr=output)
        try:
            client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 30
            while True:
                assert child.poll() is None, 'launcher exited before ready'
                try:
                    with client.open(f'http://127.0.0.1:{frontend}/guide/health', timeout=1) as response:
                        assert json.load(response) == {'status': 'ok'}
                    break
                except OSError:
                    assert time.monotonic() < deadline, 'startup timed out'
                    time.sleep(.1)
            with client.open(f'http://127.0.0.1:{frontend}/guide/ui-config', timeout=2) as response:
                assert set(json.load(response)) == {'avatar_id', 'tts_voice'}
            with client.open(f'http://127.0.0.1:{frontend}/', timeout=2) as response:
                assert b'id="root"' in response.read()
            child.send_signal(stop_signal)
            assert child.wait(timeout=15) == 0
            assert not port_is_open(frontend)
            assert not port_is_open(port)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=15)
            output.seek(0)
            print(output.read())
