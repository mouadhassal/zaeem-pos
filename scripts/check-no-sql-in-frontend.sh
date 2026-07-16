#!/usr/bin/env bash
set -euo pipefail

# CLAUDE.md R1: The frontend never touches the database.
# All SQL must go through Rust command handlers.
# This check flags getDb(), Kysely imports, and @tauri-apps/plugin-sql
# in frontend source files.
#
# Batch 3b (2026-07-16): fixed a bug that made this check useless -- the
# PATTERNS regex used `\s` and unescaped quotes without `grep -E`, which is
# not valid POSIX BRE syntax (default `grep` mode). The pattern silently
# never matched, so this script printed "OK" unconditionally regardless of
# how many violations actually existed -- it had been reporting green while
# 119 real `getDb()` call sites existed. Fixed by passing `-E` (extended
# regex, where `\s`/alternation/groups actually work as written) instead of
# rewriting the pattern to BRE syntax, since ERE was clearly the intent.
#
# FLIPPED TO BLOCKING (2026-07-16, Batch 3b closeout): the last real
# consumer (kds/page.tsx, ai/page.tsx) converted to v3 commands this slice,
# and the getDb()/Kysely/tauri_plugin_sql dependency itself was removed
# from package.json and deleted from src/db/. Proven both ways before this
# flip: red on a planted getDb() in an isolated fixture (via
# CHECK_FRONTEND_SRC), green on the real tree -- not just re-running
# against a tree already known to be clean.

# Overridable via env var so this script can be pointed at an isolated
# fixture directory for a red/green self-test, without planting a real
# violation inside the actual source tree.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${CHECK_FRONTEND_SRC:-$ROOT/src}"

PATTERNS="(getDb\s*\(|from\s+['\"]kysely['\"]|@tauri-apps/plugin-sql)"

matches=$(grep -rnE "$PATTERNS" "$SRC" --include='*.ts' --include='*.tsx' 2>/dev/null || true)

if [ -n "$matches" ]; then
    count=$(echo "$matches" | wc -l)
    echo "R1 VIOLATION: $count frontend SQL reference(s) found -- the frontend must never touch the database directly"
    echo "$matches" | head -20
    [ "$count" -gt 20 ] && echo "... and $((count - 20)) more"
    exit 1
fi

echo "OK: No frontend SQL violations"
exit 0
