#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"

pairs=(
  "src/studio-recorder.js:$runtime_root/public/recorder/studio-recorder.js"
  "src/studio-recorder.js:$runtime_root/excalidraw-app/build/recorder/studio-recorder.js"
  "src/recorder.css:$runtime_root/public/recorder/recorder.css"
  "src/recorder.css:$runtime_root/excalidraw-app/build/recorder/recorder.css"
  "src/post-editor.css:$runtime_root/public/recorder/post-editor.css"
  "src/post-editor.css:$runtime_root/excalidraw-app/build/recorder/post-editor.css"
  "src/native-bridge.js:$runtime_root/public/recorder/native-bridge.js"
  "src/native-bridge.js:$runtime_root/excalidraw-app/build/recorder/native-bridge.js"
  "src/editor-core.js:$runtime_root/public/recorder/editor-core.js"
  "src/editor-core.js:$runtime_root/excalidraw-app/build/recorder/editor-core.js"
  "src/editor-store.js:$runtime_root/public/recorder/editor-store.js"
  "src/editor-store.js:$runtime_root/excalidraw-app/build/recorder/editor-store.js"
  "src/editor-io.js:$runtime_root/public/recorder/editor-io.js"
  "src/editor-io.js:$runtime_root/excalidraw-app/build/recorder/editor-io.js"
  "src/rough-cut-core.js:$runtime_root/public/recorder/rough-cut-core.js"
  "src/rough-cut-core.js:$runtime_root/excalidraw-app/build/recorder/rough-cut-core.js"
  "src/smart-camera-core.js:$runtime_root/public/recorder/smart-camera-core.js"
  "src/smart-camera-core.js:$runtime_root/excalidraw-app/build/recorder/smart-camera-core.js"
  "src/post-editor.js:$runtime_root/public/recorder/post-editor.js"
  "src/post-editor.js:$runtime_root/excalidraw-app/build/recorder/post-editor.js"
  "server/no-cache-server.js:$runtime_root/excalidraw-app/no-cache-server.js"
  "server/render-core.js:$runtime_root/excalidraw-app/render-core.js"
  "server/render_caption_overlays.py:$runtime_root/excalidraw-app/render_caption_overlays.py"
  "server/transcribe_audio.py:$runtime_root/excalidraw-app/transcribe_audio.py"
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

version="$(node -e "const fs=require('fs'); const s=fs.readFileSync(process.argv[1],'utf8'); const m=s.match(/EC_BUILD_VERSION = \"([^\"]+)\"/); if(!m) process.exit(1); console.log(m[1])" "$repo_root/src/studio-recorder.js")"
public_index="$runtime_root/public/index.html"
build_index="$runtime_root/excalidraw-app/build/index.html"

node - "$version" "$public_index" "$build_index" <<'NODE'
const fs = require("fs");
const [version, ...indexFiles] = process.argv.slice(2);
const assets = [
  "recorder.css",
  "post-editor.css",
  "editor-core.js",
  "editor-store.js",
  "editor-io.js",
  "rough-cut-core.js",
  "smart-camera-core.js",
  "native-bridge.js",
  "studio-recorder.js",
  "post-editor.js",
];

for (const indexFile of indexFiles) {
  if (!fs.existsSync(indexFile)) {
    throw new Error(`missing deployed index: ${indexFile}`);
  }
  const html = fs.readFileSync(indexFile, "utf8");
  const refs = html.match(/(?:href|src)="\/recorder\/[^\"]+"/g) || [];
  if (refs.length !== assets.length) {
    throw new Error(`${indexFile}: expected ${assets.length} recorder references, found ${refs.length}`);
  }
  for (const asset of assets) {
    const expected = `/recorder/${asset}?v=${version}`;
    const count = refs.filter((ref) => ref.includes(expected)).length;
    if (count !== 1) {
      throw new Error(`${indexFile}: expected one current reference to ${expected}, found ${count}`);
    }
  }
}
NODE

echo "deploy verified"
