#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"
venv="$runtime_root/excalidraw-app/.venv-asr"

if command -v uv >/dev/null 2>&1; then
  uv venv "$venv" --python 3.12
  uv pip install --python "$venv/bin/python" "faster-whisper==1.2.1"
else
  python3.12 -m venv "$venv"
  "$venv/bin/python" -m pip install "faster-whisper==1.2.1"
fi

"$venv/bin/python" -c "from faster_whisper import WhisperModel; print('local ASR runtime ready')"

model_root="$HOME/.cache/huggingface/hub/models--Systran--faster-whisper-base/snapshots"
if ! find "$model_root" -mindepth 1 -maxdepth 1 -type d -print -quit 2>/dev/null | grep -q .; then
  "$venv/bin/python" -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-base')"
fi

echo "local ASR configured at $venv"
