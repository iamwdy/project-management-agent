#!/usr/bin/env bash

set -euo pipefail

PREFERENCES_CACHE_DIR="${HOME}/.config/codex"
PREFERENCES_CACHE_FILE="${PREFERENCES_CACHE_DIR}/PREFERENCES.md"
PREFERENCES_REPO_URL="https://github.com/iamwdy/codex-preferences"

echo "Project template bootstrap"
echo
echo "This script prepares the local Codex preferences cache path used by AGENTS.md."
echo "It does not install dependencies, edit .env files, or read secrets."
echo

mkdir -p "${PREFERENCES_CACHE_DIR}"

if [ -f "${PREFERENCES_CACHE_FILE}" ]; then
  echo "Preferences cache already exists:"
  echo "  ${PREFERENCES_CACHE_FILE}"
else
  cat <<EOF > "${PREFERENCES_CACHE_FILE}"
# Codex Preferences

This file is a local cache placeholder.

Preferred source of truth:
${PREFERENCES_REPO_URL}

Replace this file with the current shared preferences when needed.
EOF
  echo "Created preferences cache placeholder:"
  echo "  ${PREFERENCES_CACHE_FILE}"
fi

if [ ! -f "WIP_NOTES.md" ]; then
  cat <<'EOF' > "WIP_NOTES.md"
# WIP Notes

## Current Status
Describe the current implementation state here.

## Next Steps
- Add the next concrete task

## Risks / Open Questions
- Add unresolved issues here
EOF
  echo "Created WIP_NOTES.md template in the project root."
else
  echo "WIP_NOTES.md already exists."
fi

echo
echo "Next:"
echo "1. Read AGENTS.md"
echo "2. Review the shared Codex preferences source"
echo "3. Update README.md and project metadata for this specific project"
