#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

required_files=(
  "$repo_root/src/studio-recorder.js"
  "$repo_root/src/recorder.css"
  "$repo_root/src/native-bridge.js"
  "$repo_root/server/no-cache-server.js"
  "$repo_root/package.json"
  "$repo_root/SKILL.md"
)

for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "missing: $file"
    exit 1
  fi
done

if find "$repo_root" -name "scene.excalidraw" -o -name "scene.json" | grep -q .; then
  echo "scene files must not be committed"
  exit 1
fi

if grep -nE "title=.*Frame|aria-label.*Frame|toast\\([^)]*Frame|confirm\\([^)]*Frame|prompt\\([^)]*Frame" "$repo_root/src/studio-recorder.js" >/dev/null 2>&1; then
  echo "user-facing Frame wording may remain in src/"
  exit 1
fi

css_open="$(grep -o "{" "$repo_root/src/recorder.css" | wc -l | tr -d " ")"
css_close="$(grep -o "}" "$repo_root/src/recorder.css" | wc -l | tr -d " ")"
if [ "$css_open" != "$css_close" ]; then
  echo "css brace mismatch: $css_open/$css_close"
  exit 1
fi

echo "check ok"
