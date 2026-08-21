#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/env.sh"

mode="check"
if [ "${1:-}" = "--deploy" ]; then
  mode="deploy"
fi

failures=0
warnings=0

ok() {
  echo "ok: $1"
}

warn() {
  warnings=$((warnings + 1))
  echo "warning: $1"
}

fail() {
  failures=$((failures + 1))
  echo "missing: $1"
}

need_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 $(command -v "$1")"
  else
    fail "$1 command"
  fi
}

echo "more-excalicord preflight"
echo "repository: $repo_root"
echo "runtime root: $runtime_root"

need_cmd bash
need_cmd node
need_cmd npm
need_cmd perl
need_cmd shasum

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  if [ "$node_major" -lt 18 ]; then
    fail "Node.js 18+ (current: $(node -v 2>/dev/null || echo unknown))"
  else
    ok "Node.js $(node -v)"
  fi
fi

if [ ! -d "$runtime_root" ]; then
  fail "runtime root directory: $runtime_root"
else
  ok "runtime root exists"
fi

required_runtime_dirs=(
  "$runtime_root/public"
  "$runtime_root/excalidraw-app"
  "$runtime_root/excalidraw-app/build"
)

for dir in "${required_runtime_dirs[@]}"; do
  if [ -d "$dir" ]; then
    ok "runtime directory exists: $dir"
    if [ "$mode" = "deploy" ] && [ ! -w "$dir" ]; then
      fail "write permission for $dir"
    fi
  else
    fail "runtime directory: $dir"
  fi
done

if [ -f "$runtime_root/public/index.html" ]; then
  ok "public/index.html found"
else
  warn "public/index.html not found; deploy can still copy plugin files, but injection cache-busting may be skipped"
fi

if [ -f "$runtime_root/excalidraw-app/build/index.html" ]; then
  ok "build/index.html found"
else
  warn "excalidraw-app/build/index.html not found; deploy can still copy plugin files, but build cache-busting may be skipped"
fi

if command -v curl >/dev/null 2>&1; then
  http_code="$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5001/ 2>/dev/null || true)"
  if [ "$http_code" = "200" ]; then
    ok "http://localhost:5001/ responds with 200"
  else
    warn "http://localhost:5001/ is not responding with 200; start or restart your local Excalidraw service before browser validation"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "preflight failed: $failures missing item(s), $warnings warning(s)"
  echo "Run npm run configure:local -- --runtime-root /path/to/excalidraw if the runtime path is different."
  exit 1
fi

echo "preflight ok: $warnings warning(s)"
