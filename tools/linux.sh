#!/usr/bin/env bash
# Linux entry point; all downloaded runtimes and caches stay inside this checkout.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/.tools/node/bin:$ROOT/.tools/uv-package/bin:$PATH"
export UV_CACHE_DIR="$ROOT/.tools/cache/uv"
export UV_PYTHON_INSTALL_DIR="$ROOT/.tools/python"
export UV_CONCURRENT_DOWNLOADS="${UV_CONCURRENT_DOWNLOADS:-2}"
export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-https://mirrors.ustc.edu.cn/pypi/simple/}"
export npm_config_cache="$ROOT/.tools/cache/npm"
export PIP_CACHE_DIR="$ROOT/.tools/cache/pip"
export NO_PROXY="localhost,127.0.0.1,${NO_PROXY:-}"
TASK="$ROOT/docs/dev/20261107-linux-本机开发启动与验证流程适配"
export SPEECH_TEST_TASK_DIR="${SPEECH_TEST_TASK_DIR:-$TASK}"
export LANDSCAPE_TEST_TASK_DIR="${LANDSCAPE_TEST_TASK_DIR:-$TASK}"
export LANDSCAPE_SYSTEM_TASK="${LANDSCAPE_SYSTEM_TASK:-$TASK}"

usage() {
  echo '用法: ./tools/linux.sh {setup|doctor|dev|start|build|test|voice|embedding|opentalking}'
  echo 'setup 安装依赖；doctor 检查环境；dev 启动前后端；build 构建；test 验证；voice 语音体验工具'
}
require_runtime() {
  if [[ ! -x .venv/bin/python ]] || ! command -v node >/dev/null || [[ ! -d frontend/node_modules ]]; then
    echo '依赖未就绪，请先执行 ./tools/linux.sh setup' >&2
    exit 1
  fi
}
case "${1:-help}" in
  setup)
    mkdir -p .tools/cache/npm
    if ! command -v uv >/dev/null; then
      python3 -m pip install --target "$ROOT/.tools/uv-package" --index-url https://pypi.org/simple 'uv==0.13.7'
    fi
    if ! command -v node >/dev/null; then
      case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) echo '请安装 Node.js 22 后重试' >&2; exit 1;; esac
      archive="node-v22.16.0-linux-$arch.tar.xz"
      download="$ROOT/.tools/downloads"
      mkdir -p "$download" "$ROOT/.tools/node"
      curl --fail --location --retry 3 "https://nodejs.org/dist/v22.16.0/$archive" -o "$download/$archive"
      curl --fail --location --retry 3 https://nodejs.org/dist/v22.16.0/SHASUMS256.txt -o "$download/SHASUMS256.txt"
      (cd "$download"; awk -v name="$archive" '$2 == name' SHASUMS256.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
      tar -xJf "$download/$archive" -C "$ROOT/.tools/node" --strip-components=1
    fi
    node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("需要 Node.js >=22"); process.exit(1); }'
    uv python install --no-bin 3.11
    uv venv --allow-existing --python 3.11 .venv
    # Keep lockfile versions and hashes while allowing a local package mirror.
    uv export --frozen --no-emit-project --output-file .tools/guide-requirements.txt >/dev/null
    uv pip sync --python .venv/bin/python --require-hashes .tools/guide-requirements.txt
    uv pip install --python .venv/bin/python --no-deps -e .
    npm --prefix frontend ci --no-audit --no-fund
    npm --prefix tools/voice-experience ci --no-audit --no-fund
    npm --prefix frontend run prepare-vad-assets
    if [[ ! -e config/local.toml ]]; then
      template=config/example.toml
      if [[ -f config/ruika.example.toml ]]; then template=config/ruika.example.toml; fi
      (umask 077; cp "$template" config/local.toml)
    fi
    echo '安装完成。运行 ./tools/linux.sh dev'
    ;;
  doctor)
    require_runtime
    .venv/bin/python --version
    node --version
    .venv/bin/python -c 'import fastapi, uvicorn, openai; print("Python 依赖可用")'
    if command -v google-chrome >/dev/null; then google-chrome --version; else echo '浏览器集成测试需要 Google Chrome'; fi
    if [[ ! -f vendor/opentalking/pyproject.toml ]]; then echo 'OpenTalking 子模块未初始化；完整数字人服务尚不可用'; fi
    .venv/bin/python -c 'from exhibition_guide.config import load_config; c=load_config(); print("业务问答配置: " + ("已配置" if c.llm.enabled and c.knowledge.kb_id else "未配置（需 LLM 凭据与知识库 ID）"))'
    ;;
  dev)
    require_runtime
    exec .venv/bin/python tools/linux_dev.py
    ;;
  start)
    require_runtime
    exec .venv/bin/python tools/linux_dev.py --with-opentalking
    ;;
  embedding)
    exec .tools/opentalking-venv/bin/python tools/embedding_server.py
    ;;
  build)
    require_runtime
    npm --prefix frontend run build
    ;;
  test)
    require_runtime
    bash tools/test.sh "${2:-daily}"
    ;;
  opentalking)
    require_runtime
    shift
    exec bash tools/opentalking.sh "$@"
    ;;
  voice)
    require_runtime
    if [[ ! -f tools/voice-experience/local.json ]]; then
      echo '请先参照 tools/voice-experience/config.example.json 填写 local.json，并启动 8210 上的 OpenTalking。' >&2
      exit 1
    fi
    npm --prefix tools/voice-experience run prepare-assets
    exec node tools/voice-experience/server.mjs
    ;;
  help|-h|--help) usage;;
  *) usage >&2; exit 2;;
esac
