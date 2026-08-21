#!/usr/bin/env bash

# Shared local configuration for more-excalicord scripts.
# Create .env.local with:
#   npm run configure:local -- --runtime-root /path/to/excalidraw

if [ -z "${repo_root:-}" ]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

env_file="$repo_root/.env.local"

if [ -f "$env_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*)
        continue
        ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"

    case "$key" in
      MORE_EXCALICORD_RUNTIME_ROOT)
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        export MORE_EXCALICORD_RUNTIME_ROOT="$value"
        ;;
    esac
  done < "$env_file"
fi

runtime_root="${MORE_EXCALICORD_RUNTIME_ROOT:-$HOME/.local/share/excalidraw}"
case "$runtime_root" in
  "~"|"~/"*)
    runtime_root="${runtime_root/#\~/$HOME}"
    ;;
esac
