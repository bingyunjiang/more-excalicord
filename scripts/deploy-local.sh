#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"
bash "$repo_root/scripts/preflight.sh" --deploy
public_recorder="$runtime_root/public/recorder"
build_recorder="$runtime_root/excalidraw-app/build/recorder"
server_target="$runtime_root/excalidraw-app/no-cache-server.js"
public_index="$runtime_root/public/index.html"
build_index="$runtime_root/excalidraw-app/build/index.html"

version="$(node -e "const fs=require('fs'); const s=fs.readFileSync(process.argv[1],'utf8'); const m=s.match(/EC_BUILD_VERSION = \"([^\"]+)\"/); if(!m) process.exit(1); console.log(m[1])" "$repo_root/src/studio-recorder.js")"

mkdir -p "$public_recorder" "$build_recorder"
cp "$repo_root/src/studio-recorder.js" "$public_recorder/studio-recorder.js"
cp "$repo_root/src/studio-recorder.js" "$build_recorder/studio-recorder.js"
cp "$repo_root/src/recorder.css" "$public_recorder/recorder.css"
cp "$repo_root/src/recorder.css" "$build_recorder/recorder.css"
cp "$repo_root/src/native-bridge.js" "$public_recorder/native-bridge.js"
cp "$repo_root/src/native-bridge.js" "$build_recorder/native-bridge.js"
mkdir -p "$public_recorder/vendor" "$build_recorder/vendor"
cp -R "$repo_root/src/vendor/." "$public_recorder/vendor/"
cp -R "$repo_root/src/vendor/." "$build_recorder/vendor/"
cp "$repo_root/server/no-cache-server.js" "$server_target"

for index_file in "$public_index" "$build_index"; do
  if [ -f "$index_file" ]; then
    perl -0pi -e "s#/recorder/recorder\.css\?v=[^\"']+#/recorder/recorder.css?v=$version#g; s#/recorder/native-bridge\.js\?v=[^\"']+#/recorder/native-bridge.js?v=$version#g; s#/recorder/studio-recorder\.js\?v=[^\"']+#/recorder/studio-recorder.js?v=$version#g" "$index_file"
  fi
done

bash "$repo_root/scripts/verify-deploy.sh"
echo "deployed $version"
