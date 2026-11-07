"""CLI integration: patch a pristine pinned checkout, apply twice, reject drift."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def test_pinned_upstream_patch_is_repeatable_and_rejects_conflicts(tmp_path):
    upstream = tmp_path / "upstream"
    subprocess.run(["git", "clone", "--quiet", "--shared", str(ROOT / "vendor/opentalking"), str(upstream)], check=True)
    command = [sys.executable, str(ROOT / "tools/opentalking_patch.py"), "--source", str(upstream)]
    first = subprocess.run(command, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    assert first.stdout.strip() == "applied"
    second = subprocess.run(command, capture_output=True, text=True)
    assert second.returncode == 0 and second.stdout.strip() == "already applied"
    # The patch is syntax valid in both the API and worker entry points.
    subprocess.run([sys.executable, "-m", "compileall", "-q",
                    str(upstream / "apps/api/routes/sessions.py"),
                    str(upstream / "apps/api/services/session_service.py"),
                    str(upstream / "opentalking/runtime/task_consumer.py"),
                    str(upstream / "opentalking/pipeline/speak/synthesis_runner.py")], check=True)
    route = upstream / "apps/api/routes/sessions.py"
    route.write_text(route.read_text().replace('segment_id=segment_id', 'segment_id="conflicting-edit"'))
    conflict = subprocess.run(command, capture_output=True, text=True)
    assert conflict.returncode != 0
    assert "conflicting edits" in conflict.stderr
    assert 'segment_id="conflicting-edit"' in route.read_text()
