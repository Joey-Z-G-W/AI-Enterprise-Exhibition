#!/usr/bin/env bash
# Main-project test entrypoints; never collect tests from vendor/opentalking.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.tools/node/bin:$PATH"
export PYTHONPATH="$ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
export GUIDE_PYTHON="${GUIDE_PYTHON:-$ROOT/.venv/bin/python}"
export NO_PROXY="localhost,127.0.0.1,${NO_PROXY:-}"
TASK="$ROOT/docs/dev/20261108-测试体系-组件集成与业务验收测试重整"
export TEST_TASK_DIR="${TEST_TASK_DIR:-${GUIDE_TEST_TASK_DIR:-$TASK}}"
export GUIDE_TEST_TASK_DIR="$TEST_TASK_DIR"
export SPEECH_TEST_TASK_DIR="$TEST_TASK_DIR"
export LANDSCAPE_TEST_TASK_DIR="$TEST_TASK_DIR"
export LANDSCAPE_SYSTEM_TASK="$TEST_TASK_DIR"
export AUDIO_TEST_WAV="${AUDIO_TEST_WAV:-$ROOT/tests/fixtures/speech.wav}"
mkdir -p "$TEST_TASK_DIR/evidence" "$TEST_TASK_DIR/tmp"
case "${1:-daily}" in
  components)
    "$GUIDE_PYTHON" -m pytest tests -q -m 'not acceptance and not system' --basetemp "$TEST_TASK_DIR/tmp/pytest-components"
    npm --prefix tools/voice-experience test
    npm --prefix frontend run prepare-vad-assets
    for test in speech-browser-integration landscape-browser-integration audio-barge-integration stage-browser-integration tour-browser-integration vad-dev-integration; do
      node "tests/frontend/$test.cjs"
    done
    ;;
  e2e)
    npm --prefix frontend run prepare-vad-assets
    node tests/frontend/landscape-system-integration.cjs
    ;;
  system|deployment)
    "$GUIDE_PYTHON" -m pytest tests/test_embedding_http.py -q -o addopts='' --basetemp "$TEST_TASK_DIR/tmp/pytest-system"
    node tests/frontend/tour-rtc-system.cjs
    ;;
  acceptance)
    : "${GUIDE_ACCEPTANCE_ORIGIN:?真实业务验收需设置 GUIDE_ACCEPTANCE_ORIGIN（如 http://127.0.0.1:5290/guide）}"
    : "${GUIDE_ACCEPTANCE_QUESTION:?需设置知识库中有确定依据的 GUIDE_ACCEPTANCE_QUESTION}"
    : "${GUIDE_ACCEPTANCE_SOURCE:?需设置预期来源文件名 GUIDE_ACCEPTANCE_SOURCE}"
    : "${GUIDE_ACCEPTANCE_TEXT:?需设置首轮答案应包含的事实片段 GUIDE_ACCEPTANCE_TEXT}"
    : "${GUIDE_ACCEPTANCE_ASSET_ID:?需设置首轮应出现的图片 ID GUIDE_ACCEPTANCE_ASSET_ID}"
    : "${GUIDE_ACCEPTANCE_FOLLOWUP_QUESTION:?需设置依赖首轮语境的追问 GUIDE_ACCEPTANCE_FOLLOWUP_QUESTION}"
    : "${GUIDE_ACCEPTANCE_FOLLOWUP_TEXT:?需设置追问答案应包含的事实片段 GUIDE_ACCEPTANCE_FOLLOWUP_TEXT}"
    : "${GUIDE_ACCEPTANCE_FOLLOWUP_SOURCE:?需设置追问预期来源文件名 GUIDE_ACCEPTANCE_FOLLOWUP_SOURCE}"
    : "${TOUR_LIVE_ORIGIN:?真实语音取消验收需设置 TOUR_LIVE_ORIGIN}"
    export TOUR_CANCEL_EVIDENCE="$TEST_TASK_DIR/evidence/live-cancel.json"
    "$GUIDE_PYTHON" -m pytest tests/test_live_acceptance.py tests/test_tour_cancel_system.py -q -o addopts='' --basetemp "$TEST_TASK_DIR/tmp/pytest-acceptance"
    ;;
  daily)
    bash tools/test.sh components
    bash tools/test.sh e2e
    ;;
  *) echo '用法: bash tools/test.sh {daily|components|system|e2e|deployment|acceptance}' >&2; exit 2 ;;
esac
