#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"
bash "$repo_root/scripts/preflight.sh" --deploy
public_recorder="$runtime_root/public/recorder"
build_recorder="$runtime_root/excalidraw-app/build/recorder"
server_target="$runtime_root/excalidraw-app/no-cache-server.js"
render_core_target="$runtime_root/excalidraw-app/render-core.js"
caption_renderer_target="$runtime_root/excalidraw-app/render_caption_overlays.py"
transcribe_target="$runtime_root/excalidraw-app/transcribe_audio.py"
public_index="$runtime_root/public/index.html"
build_index="$runtime_root/excalidraw-app/build/index.html"

version="$(node -e "const fs=require('fs'); const s=fs.readFileSync(process.argv[1],'utf8'); const m=s.match(/EC_BUILD_VERSION = \"([^\"]+)\"/); if(!m) process.exit(1); console.log(m[1])" "$repo_root/src/studio-recorder.js")"

mkdir -p "$public_recorder" "$build_recorder"
cp "$repo_root/src/studio-recorder.js" "$public_recorder/studio-recorder.js"
cp "$repo_root/src/studio-recorder.js" "$build_recorder/studio-recorder.js"
cp "$repo_root/src/recorder.css" "$public_recorder/recorder.css"
cp "$repo_root/src/recorder.css" "$build_recorder/recorder.css"
cp "$repo_root/src/post-editor.css" "$public_recorder/post-editor.css"
cp "$repo_root/src/post-editor.css" "$build_recorder/post-editor.css"
cp "$repo_root/src/native-bridge.js" "$public_recorder/native-bridge.js"
cp "$repo_root/src/native-bridge.js" "$build_recorder/native-bridge.js"
cp "$repo_root/src/editor-core.js" "$public_recorder/editor-core.js"
cp "$repo_root/src/editor-core.js" "$build_recorder/editor-core.js"
cp "$repo_root/src/editor-store.js" "$public_recorder/editor-store.js"
cp "$repo_root/src/editor-store.js" "$build_recorder/editor-store.js"
cp "$repo_root/src/editor-io.js" "$public_recorder/editor-io.js"
cp "$repo_root/src/editor-io.js" "$build_recorder/editor-io.js"
cp "$repo_root/src/rough-cut-core.js" "$public_recorder/rough-cut-core.js"
cp "$repo_root/src/rough-cut-core.js" "$build_recorder/rough-cut-core.js"
cp "$repo_root/src/smart-camera-core.js" "$public_recorder/smart-camera-core.js"
cp "$repo_root/src/smart-camera-core.js" "$build_recorder/smart-camera-core.js"
cp "$repo_root/src/post-editor.js" "$public_recorder/post-editor.js"
cp "$repo_root/src/post-editor.js" "$build_recorder/post-editor.js"
mkdir -p "$public_recorder/vendor" "$build_recorder/vendor"
cp -R "$repo_root/src/vendor/." "$public_recorder/vendor/"
cp -R "$repo_root/src/vendor/." "$build_recorder/vendor/"
cp "$repo_root/server/no-cache-server.js" "$server_target"
cp "$repo_root/server/render-core.js" "$render_core_target"
cp "$repo_root/server/render_caption_overlays.py" "$caption_renderer_target"
cp "$repo_root/server/transcribe_audio.py" "$transcribe_target"
chmod +x "$caption_renderer_target" "$transcribe_target"

for index_file in "$public_index" "$build_index"; do
  if [ -f "$index_file" ]; then
    perl -0pi -e "s#<link rel=\"stylesheet\" href=\"/recorder/(?:recorder|post-editor)\.css\?v=[^\"]+\"\s*/?>\s*##g; s#<script defer(?:=\"defer\")? src=\"/recorder/(?:editor-core|editor-store|editor-io|rough-cut-core|smart-camera-core|native-bridge|studio-recorder|post-editor)\.js\?v=[^\"]+\"></script>\s*##g; s#</body>#<link rel=\"stylesheet\" href=\"/recorder/recorder.css?v=$version\"/><link rel=\"stylesheet\" href=\"/recorder/post-editor.css?v=$version\"/><script defer=\"defer\" src=\"/recorder/editor-core.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/editor-store.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/editor-io.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/rough-cut-core.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/smart-camera-core.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/native-bridge.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/studio-recorder.js?v=$version\"></script><script defer=\"defer\" src=\"/recorder/post-editor.js?v=$version\"></script></body>#g" "$index_file"
  fi
done

bash "$repo_root/scripts/verify-deploy.sh"
echo "web runtime deployed $version"

# Keep the native helper last. Replacing its launchd service can terminate or
# detach the invoking shell on some macOS versions; the web runtime must already
# be complete and verified before that happens.
bash "$repo_root/scripts/deploy-capture-agent.sh"
echo "deployed $version"
