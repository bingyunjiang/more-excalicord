#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"

pairs=(
  "src/studio-recorder.js:$runtime_root/public/recorder/studio-recorder.js"
  "src/studio-recorder.js:$runtime_root/excalidraw-app/build/recorder/studio-recorder.js"
  "src/recorder.css:$runtime_root/public/recorder/recorder.css"
  "src/recorder.css:$runtime_root/excalidraw-app/build/recorder/recorder.css"
  "src/native-bridge.js:$runtime_root/public/recorder/native-bridge.js"
  "server/no-cache-server.js:$runtime_root/excalidraw-app/no-cache-server.js"
)

for pair in "${pairs[@]}"; do
  src_rel="${pair%%:*}"
  dst="${pair#*:}"
  if [ ! -f "$dst" ]; then
    echo "missing deployed file: $dst"
    exit 1
  fi
  src_hash="$(shasum -a 256 "$repo_root/$src_rel" | awk '{print $1}')"
  dst_hash="$(shasum -a 256 "$dst" | awk '{print $1}')"
  if [ "$src_hash" != "$dst_hash" ]; then
    echo "deploy mismatch: $src_rel -> $dst"
    exit 1
  fi
done

echo "deploy verified"
