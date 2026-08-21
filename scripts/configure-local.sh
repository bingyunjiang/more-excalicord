#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  npm run configure:local -- --runtime-root /path/to/excalidraw
  npm run configure:local -- /path/to/excalidraw
  npm run setup:local

This writes .env.local with MORE_EXCALICORD_RUNTIME_ROOT.
USAGE
}

runtime_arg=""
auto="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-root)
      if [ "$#" -lt 2 ]; then
        echo "missing value for --runtime-root"
        usage
        exit 2
      fi
      shift
      runtime_arg="$1"
      ;;
    --runtime-root=*)
      runtime_arg="${1#--runtime-root=}"
      ;;
    --auto)
      auto="1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$runtime_arg" ]; then
        runtime_arg="$1"
      else
        echo "unexpected argument: $1"
        usage
        exit 2
      fi
      ;;
  esac
  shift
done

if [ -z "$runtime_arg" ]; then
  runtime_arg="${MORE_EXCALICORD_RUNTIME_ROOT:-$HOME/.local/share/excalidraw}"
fi

case "$runtime_arg" in
  "~"|"~/"*)
    runtime_arg="${runtime_arg/#\~/$HOME}"
    ;;
esac

escaped_runtime="${runtime_arg//\"/\\\"}"
env_file="$repo_root/.env.local"

{
  echo "# Local deployment configuration for more-excalicord."
  echo "# This file is intentionally ignored by Git."
  echo "MORE_EXCALICORD_RUNTIME_ROOT=\"$escaped_runtime\""
} > "$env_file"

echo "configured: $env_file"
echo "runtime root: $runtime_arg"

if [ ! -d "$runtime_arg" ]; then
  echo "warning: runtime root does not exist yet."
  echo "Create or install your self-hosted Excalidraw runtime first, then run npm run preflight."
  if [ "$auto" = "1" ]; then
    exit 0
  fi
fi
