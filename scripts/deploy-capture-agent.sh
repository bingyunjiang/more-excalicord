#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_root="$repo_root/native/capture-agent/macos"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "capture agent skipped: macOS only"
  exit 0
fi
if [ "${MORE_EXCALICORD_SKIP_CAPTURE_AGENT:-0}" = "1" ]; then
  echo "capture agent skipped by MORE_EXCALICORD_SKIP_CAPTURE_AGENT"
  exit 0
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "capture agent skipped: Swift toolchain not found"
  exit 0
fi
if [ ! -x "$native_root/scripts/install-agent.sh" ]; then
  echo "capture agent source is incomplete: $native_root"
  exit 1
fi

/bin/zsh "$native_root/scripts/install-agent.sh" >/dev/null
/bin/zsh "$native_root/scripts/smoke-test.sh"
echo "capture agent deployed from repository source"
