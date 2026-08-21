#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "repository: $repo_root"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "branch: $(git branch --show-current 2>/dev/null || true)"
  echo "head: $(git rev-parse --short HEAD 2>/dev/null || true)"
  git status --short
  if git remote get-url origin >/dev/null 2>&1; then
    echo "origin: $(git remote get-url origin)"
    git rev-list --left-right --count HEAD...origin/$(git branch --show-current) 2>/dev/null || true
  else
    echo "origin: not set"
  fi
else
  echo "git: not initialized"
fi

bash "$repo_root/scripts/verify-deploy.sh"
