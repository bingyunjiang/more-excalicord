#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git repository"
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "tracked changes are not committed; commit before packaging"
  exit 1
fi

version="$(node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); console.log(pkg.version)")"
short_head="$(git rev-parse --short HEAD)"
mkdir -p dist
archive="dist/more-excalicord-v${version}-${short_head}.zip"
git archive --format=zip --output="$archive" HEAD

echo "$archive"
