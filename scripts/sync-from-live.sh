#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"
public_recorder="$runtime_root/public/recorder"

cp "$public_recorder/studio-recorder.js" "$repo_root/src/studio-recorder.js"
cp "$public_recorder/recorder.css" "$repo_root/src/recorder.css"
if [ -f "$public_recorder/post-editor.css" ]; then
  cp "$public_recorder/post-editor.css" "$repo_root/src/post-editor.css"
fi
cp "$public_recorder/native-bridge.js" "$repo_root/src/native-bridge.js"
if [ -f "$public_recorder/editor-core.js" ]; then
  cp "$public_recorder/editor-core.js" "$repo_root/src/editor-core.js"
fi
if [ -f "$public_recorder/editor-store.js" ]; then
  cp "$public_recorder/editor-store.js" "$repo_root/src/editor-store.js"
fi
if [ -f "$public_recorder/editor-io.js" ]; then
  cp "$public_recorder/editor-io.js" "$repo_root/src/editor-io.js"
fi
if [ -f "$public_recorder/rough-cut-core.js" ]; then
  cp "$public_recorder/rough-cut-core.js" "$repo_root/src/rough-cut-core.js"
fi
if [ -f "$public_recorder/smart-camera-core.js" ]; then
  cp "$public_recorder/smart-camera-core.js" "$repo_root/src/smart-camera-core.js"
fi
if [ -f "$public_recorder/post-editor.js" ]; then
  cp "$public_recorder/post-editor.js" "$repo_root/src/post-editor.js"
fi
mkdir -p "$repo_root/src/vendor"
cp -R "$public_recorder/vendor/." "$repo_root/src/vendor/"
cp "$runtime_root/excalidraw-app/no-cache-server.js" "$repo_root/server/no-cache-server.js"
if [ -f "$runtime_root/excalidraw-app/render-core.js" ]; then
  cp "$runtime_root/excalidraw-app/render-core.js" "$repo_root/server/render-core.js"
fi
if [ -f "$runtime_root/excalidraw-app/render_caption_overlays.py" ]; then
  cp "$runtime_root/excalidraw-app/render_caption_overlays.py" "$repo_root/server/render_caption_overlays.py"
fi
if [ -f "$runtime_root/excalidraw-app/transcribe_audio.py" ]; then
  cp "$runtime_root/excalidraw-app/transcribe_audio.py" "$repo_root/server/transcribe_audio.py"
fi

npm run check
echo "synced from live runtime"
