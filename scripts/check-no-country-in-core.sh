#!/usr/bin/env bash
set -euo pipefail

# ARCHITECTURE_V2.md §3: No country logic in core.
# Checks frontend src/ and Rust core/ (once it exists).
# Expected to fail today — core/ module doesn't exist yet, and
# the frontend may contain country references.
#
# Batch 3b (2026-07-16): same bug class as check-no-sql-in-frontend.sh, same
# author/era, confirmed by grep review as instructed -- PATTERNS used `|`
# alternation but every `grep` call was missing `-E`. Default `grep` (POSIX
# BRE) treats `|` as a LITERAL character, not alternation, so this pattern
# only ever matched the literal 27-character string "Syria|SY|Saudi|ZATCA|SYP"
# appearing verbatim in a file -- never once, on any real file. This script
# had been printing "OK: No country logic in core/" unconditionally,
# regardless of how many real country references existed (verified: `money.rs`
# alone has multiple literal `"SYP"` matches once `-E` is added). Fixed by
# adding `-E` to both `grep -rn` calls.
#
# `CORE_DIR`/`FRONTEND_SRC` are overridable via env vars so this script can be
# pointed at an isolated fixture directory for a red/green self-test, without
# needing to plant a real violation inside the actual source tree.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DIR="${CHECK_CORE_DIR:-$ROOT/src-tauri/src/core}"
FRONTEND_SRC="${CHECK_FRONTEND_SRC:-$ROOT/src}"

PATTERNS="Syria|SY|Saudi|ZATCA|SYP"

HAS_ERRORS=0

if [ -d "$CORE_DIR" ]; then
    matches=$(grep -rnE "$PATTERNS" "$CORE_DIR" 2>/dev/null || true)
    if [ -n "$matches" ]; then
        echo "FAIL: Country logic found in core/"
        echo "$matches"
        HAS_ERRORS=1
    fi
fi

matches=$(grep -rnE "$PATTERNS" "$FRONTEND_SRC" 2>/dev/null || true)
if [ -n "$matches" ]; then
    echo "WARNING: Country references found in frontend src/"
    echo "$matches"
fi

if [ "$HAS_ERRORS" -eq 1 ]; then
    exit 1
fi

echo "OK: No country logic in core/"
exit 0
