#!/usr/bin/env bash
set -euo pipefail

SOURCE_REF="${1:-}"
PATH_FILE="${2:-.github/template-sync-paths.txt}"

if [[ -z "$SOURCE_REF" ]]; then
  echo "usage: scripts/sync-template-paths.sh <git-ref> [path-file]" >&2
  exit 1
fi

if [[ ! -f "$PATH_FILE" ]]; then
  echo "path file not found: $PATH_FILE" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required" >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$TMP_DIR" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

git worktree add --detach "$TMP_DIR" "$SOURCE_REF" >/dev/null

while IFS= read -r raw_path || [[ -n "$raw_path" ]]; do
  path="${raw_path%%#*}"
  path="${path%"${path##*[![:space:]]}"}"
  path="${path#"${path%%[![:space:]]*}"}"

  if [[ -z "$path" ]]; then
    continue
  fi

  src="$TMP_DIR/$path"
  dst="$ROOT/$path"

  if [[ -d "$src" ]]; then
    mkdir -p "$dst"
    rsync -a --delete "$src"/ "$dst"/
    continue
  fi

  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    continue
  fi

  rm -rf "$dst"
done <"$PATH_FILE"
