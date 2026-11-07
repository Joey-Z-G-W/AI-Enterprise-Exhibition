#!/usr/bin/env bash
# Invoked by linux.sh so Python/tool caches and package mirror are consistent.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUNTIME="$ROOT/.tools/opentalking-venv"
SOURCE="$ROOT/vendor/opentalking"
export HF_HOME="$ROOT/.tools/cache/huggingface"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export HF_HUB_DISABLE_XET=1
export HF_HUB_DOWNLOAD_TIMEOUT=120
export MODELSCOPE_CACHE="$ROOT/.tools/cache/modelscope"
export TORCH_HOME="$ROOT/.tools/cache/torch"
export NUMBA_CACHE_DIR="$ROOT/.tools/cache/numba"
export MPLCONFIGDIR="$ROOT/.tools/cache/matplotlib"
export OPENTALKING_MODEL_ROOT="$ROOT/models"
export OPENTALKING_QUICKTALK_ASSET_ROOT="$ROOT/models/quicktalk"
export OPENTALKING_LOCAL_AUDIO_MODEL_ROOT="$ROOT/models/local-audio"
export OPENTALKING_STT_SENSEVOICE_MODEL_DIR="$ROOT/models/local-audio/iic__SenseVoiceSmall"
export OPENTALKING_CONFIG_FILE="$SOURCE/configs/default.yaml"
export OPENTALKING_AVATARS_DIR="$ROOT/data/opentalking/avatars"
export OPENTALKING_EXPORTS_DIR="$ROOT/data/opentalking/exports"
export OPENTALKING_AGENT_KNOWLEDGE_ROOT="$ROOT/data/opentalking/knowledge"
export OPENTALKING_SQLITE_PATH="$ROOT/data/opentalking/opentalking.sqlite3"
case "${1:-help}" in
  setup)
    git submodule update --init --depth 1 vendor/opentalking
    uv venv --allow-existing --python "$ROOT/.venv/bin/python" "$RUNTIME"
    uv pip install --python "$RUNTIME/bin/python" -c config/opentalking-constraints.txt -e "$SOURCE[models,quicktalk-cuda,local-audio]"
    mkdir -p "$OPENTALKING_AVATARS_DIR"
    if [[ ! -d "$OPENTALKING_AVATARS_DIR/companion" ]]; then
      cp -a "$SOURCE/examples/avatars/companion" "$OPENTALKING_AVATARS_DIR/"
    fi
    if [[ ! -e config/opentalking.env ]]; then
      (umask 077; cp config/opentalking.example.env config/opentalking.env)
    fi
    ;;
  download)
    "$RUNTIME/bin/hf" download datascale-ai/quicktalk --revision 532a36f58232fa80ee86274b3a0564b75b4f8c25 --local-dir "$OPENTALKING_QUICKTALK_ASSET_ROOT/checkpoints" --max-workers 2
    "$RUNTIME/bin/python" "$SOURCE/scripts/download_local_audio_models.py" --model sensevoice-small
    "$RUNTIME/bin/hf" download BAAI/bge-small-zh-v1.5 --revision 7999e1d3359715c523056ef9478215996d62a620 --local-dir "$ROOT/models/bge-small-zh-v1.5" --include 'config.json' 'tokenizer*' 'vocab.txt' 'special_tokens_map.json' 'pytorch_model.bin' 'README.md' --max-workers 2
    ;;
  dev)
    if [[ ! -f config/opentalking.env || ! -x "$RUNTIME/bin/python" ]]; then
      echo '请先运行 ./tools/linux.sh opentalking setup 和 download' >&2
      exit 1
    fi
    set -a
    source config/opentalking.env
    set +a
    export OPENTALKING_FFMPEG_BIN="$("$RUNTIME/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
    mkdir -p "$ROOT/data/opentalking"
    cd "$ROOT/data/opentalking"
    exec "$RUNTIME/bin/python" "$ROOT/tools/opentalking_runtime.py"
    ;;
  *) echo '用法: ./tools/linux.sh opentalking {setup|download|dev}'; exit 2;;
esac
