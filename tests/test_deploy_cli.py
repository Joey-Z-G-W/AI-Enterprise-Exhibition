"""Public deployment CLI contracts; no internal functions or substitutes."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def cli(*args):
    return subprocess.run([sys.executable, str(ROOT / 'tools/course_deploy.py'), *args], capture_output=True, text=True)


def test_help_exposes_safe_operations():
    result = cli('--help')
    assert result.returncode == 0
    assert all(word in result.stdout for word in ('watch', 'deploy', 'promote', 'rollback', 'status'))


def test_status_is_read_only_and_reports_no_release(tmp_path):
    result = cli('--state-dir', str(tmp_path), 'status')
    assert result.returncode == 0
    assert json.loads(result.stdout) == {'dev': {}, 'prod': {}}


def test_rollback_without_verified_release_fails_without_docker(tmp_path):
    result = cli('--state-dir', str(tmp_path), 'rollback', '--environment', 'prod')
    assert result.returncode != 0
    assert 'previous verified release' in result.stderr


def test_run_identifier_rejects_shell_input():
    result = cli('deploy', '--run-id', '1;echo secret')
    assert result.returncode != 0
    assert 'invalid int value' in result.stderr
