#!/usr/bin/env bash
set -euo pipefail

# ARCHITECTURE_V2.md §3: No country logic in core.
# Checks frontend src/ and Rust core/ (once it exists).
# Expected to fail today — core/ module doesn't exist yet, and
# the frontend may contain country references.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DIR="$ROOT/src-tauri/src/core"
FRONTEND_SRC="$ROOT/src"

PATTERNS="Syria|SY|Saudi|ZATCA|SYP"

HAS_ERRORS=0

if [ -d "$CORE_DIR" ]; then
    matches=$(grep -rn "$PATTERNS" "$CORE_DIR" 2>/dev/null || true)
    if [ -n "$matches" ]; then
        echo "FAIL: Country logic found in core/"
        echo "$matches"
        HAS_ERRORS=1
    fi
fi

matches=$(grep -rn "$PATTERNS" "$FRONTEND_SRC" 2>/dev/null || true)
if [ -n "$matches" ]; then
    echo "WARNING: Country references found in frontend src/"
    echo "$matches"
fi

if [ "$HAS_ERRORS" -eq 1 ]; then
    exit 1
fi

echo "OK: No country logic in core/"
exit 0
