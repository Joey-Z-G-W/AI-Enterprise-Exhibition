"""Idempotently apply the segment-event compatibility patch to the pinned upstream."""
from pathlib import Path
import argparse
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REVISION = "8c739a5a6f114daf71aeace832a668c3ad60f536"


def apply_patch(source: Path) -> str:
    def git(*args):
        return subprocess.run(["git", "-C", str(source), *args], capture_output=True, text=True)

    revision = git("rev-parse", "HEAD")
    if revision.returncode or revision.stdout.strip() != REVISION:
        raise RuntimeError("OpenTalking revision differs from the reviewed segment-event patch baseline")
    patch = str(ROOT / "config/opentalking-segment-events.patch")
    if git("apply", "--reverse", "--check", patch).returncode == 0:
        return "already applied"
    if git("apply", "--check", patch).returncode:
        raise RuntimeError("OpenTalking has conflicting edits; segment-event patch was not applied")
    result = git("apply", patch)
    if result.returncode:
        raise RuntimeError("Could not apply OpenTalking segment-event patch")
    return "applied"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "vendor/opentalking")
    print(apply_patch(parser.parse_args().source))
