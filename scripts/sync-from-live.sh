#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"
public_recorder="$runtime_root/public/recorder"

cp "$public_recorder/studio-recorder.js" "$repo_root/src/studio-recorder.js"
cp "$public_recorder/recorder.css" "$repo_root/src/recorder.css"
cp "$public_recorder/native-bridge.js" "$repo_root/src/native-bridge.js"
mkdir -p "$repo_root/src/vendor"
cp -R "$public_recorder/vendor/." "$repo_root/src/vendor/"
cp "$runtime_root/excalidraw-app/no-cache-server.js" "$repo_root/server/no-cache-server.js"

npm run check
echo "synced from live runtime"
