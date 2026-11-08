#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools/node/bin:$PWD/.tools/uv-package/bin:$PATH"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
export GUIDE_PYTHON="${GUIDE_PYTHON:-$PWD/.venv/bin/python}"
export GUIDE_TEST_TASK_DIR="${GUIDE_TEST_TASK_DIR:-$PWD/docs/dev/20261107-课程项目-展厅AI导览高分交付分批规划}"
mkdir -p "$GUIDE_TEST_TASK_DIR/tmp" "$GUIDE_TEST_TASK_DIR/evidence"
npm --prefix tools/voice-experience ci --no-audit --no-fund
npm --prefix frontend run build
npm --prefix frontend run test:components
npm --prefix frontend run test:e2e
VITE_GUIDE_MODE=demo npm --prefix frontend run build
node tests/frontend/demo-system.cjs
