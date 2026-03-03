#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/new-project.sh <project-name-or-path>

Behavior:
  - copies this template into the target directory
  - excludes template git metadata and local junk files
  - runs scripts/bootstrap-project.sh in the new project

Examples:
  scripts/new-project.sh my-new-project
  scripts/new-project.sh ../client-portal
EOF
}

if [ "${1:-}" = "" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_INPUT="$1"

case "${TARGET_INPUT}" in
  /*) TARGET_DIR="${TARGET_INPUT}" ;;
  *) TARGET_DIR="$(cd "${PWD}" && pwd)/${TARGET_INPUT}" ;;
esac

if [ -e "${TARGET_DIR}" ] && [ -n "$(find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "Refusing to initialize a non-empty directory:"
  echo "  ${TARGET_DIR}"
  exit 1
fi

mkdir -p "${TARGET_DIR}"

tar -C "${TEMPLATE_ROOT}" \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='WIP_NOTES.md' \
  -cf - . | tar -C "${TARGET_DIR}" -xf -

(
  cd "${TARGET_DIR}"
  ./scripts/bootstrap-project.sh
)

echo
echo "Created project from template:"
echo "  ${TARGET_DIR}"
echo
echo "Next:"
echo "1. Open ${TARGET_DIR}"
echo "2. Read AGENTS.md"
echo "3. Update README.md for the specific project"
