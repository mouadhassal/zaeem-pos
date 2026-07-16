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
# Still NOT flipped to blocking (still exits 0 on violations) -- 119 real
# getDb() call sites remain across menu CRUD, inventory, finance, debt,
# loyalty, settings, reports, and the customers/PO/delivery/printer pages,
# none converted yet. Flip this to `exit 1` only once that count is
# genuinely zero -- doing it now would break every dev/CI run for reasons
# that have nothing to do with a regression.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"

PATTERNS="(getDb\s*\(|from\s+['\"]kysely['\"]|@tauri-apps/plugin-sql)"

matches=$(grep -rnE "$PATTERNS" "$SRC" --include='*.ts' --include='*.tsx' 2>/dev/null || true)

if [ -n "$matches" ]; then
    count=$(echo "$matches" | wc -l)
    echo "NOT YET GREEN: $count frontend SQL reference(s) found (R1 violation, tracked, not blocking yet)"
    echo "$matches" | head -20
    [ "$count" -gt 20 ] && echo "... and $((count - 20)) more"
    exit 0
fi

echo "OK: No frontend SQL violations -- safe to flip this script to blocking (exit 1) now"
exit 0
