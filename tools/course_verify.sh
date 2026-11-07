#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools/node/bin:$PWD/.tools/uv-package/bin:$PATH"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
export GUIDE_PYTHON="${GUIDE_PYTHON:-$PWD/.venv/bin/python}"
export GUIDE_TEST_TASK_DIR="${GUIDE_TEST_TASK_DIR:-$PWD/docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划}"
mkdir -p "$GUIDE_TEST_TASK_DIR/tmp" "$GUIDE_TEST_TASK_DIR/evidence"
"$GUIDE_PYTHON" -m pytest -q --basetemp "$GUIDE_TEST_TASK_DIR/tmp/pytest"
npm --prefix frontend run build
npm --prefix frontend run test:browser
npm --prefix frontend run test:landscape
npm --prefix frontend run test:system
npm --prefix frontend run test:vad-dev
VITE_GUIDE_MODE=demo npm --prefix frontend run build
node tests/frontend/demo-system.cjs
