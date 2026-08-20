#!/usr/bin/env bash
set -euo pipefail

# ZAEEM_POS_PLATFORM_PLAN.md §7 Step 1: a ratchet against restaurant-specific
# vocabulary leaking into what should become kernel territory (the
# kernel/pack multi-vertical platform work). The plan's own naive grep
# recipe (`menu|table|kitchen|course|modifier|chef|dine_in`) was checked
# against this real codebase in _platform_plan_reconciliation.md and found
# to be >90% false positives dominated by generic SQL `CREATE TABLE`/
# `table_exists`/`sync_queue` hits, while missing real restaurant nouns
# already baked into the schema (`kds`, `recipe`, `ingredient`, `combo`,
# `happy_hour`). This is the corrected version: whole-word, case-insensitive,
# with the generic-SQL noise excluded and the missing terms added.
#
# "server" is deliberately NOT in the term list -- the reconciliation
# grepped it across 25 files and found it was "almost entirely false
# positives (server-side, SQL server, generic backend/service references);
# not a 'waitstaff' concept anywhere. No genuine hit." Including it would
# just reintroduce the exact false-positive-domination problem this script
# exists to fix.
#
# This is a standalone script, not wired into CI (no CI config exists in
# this repo to hook into) -- run it manually:
#   ./scripts/vocab_ratchet.sh            # print current count, compare to baseline
#   ./scripts/vocab_ratchet.sh --update   # overwrite the baseline with the current count
#
# Exit code is 0 whether or not the ratchet passes/fails to update --
# only `--check`-less runs against a HIGHER count than the baseline (no
# --update flag) exit 1. This mirrors this repo's other scripts/*.sh
# check-no-*.sh convention (see those files for the pattern this follows).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${CHECK_FRONTEND_SRC:-$ROOT/src}"
RUST_SRC="${CHECK_RUST_SRC:-$ROOT/src-tauri/src}"
BASELINE_FILE="${VOCAB_RATCHET_BASELINE:-$ROOT/.vocab_ratchet_baseline.txt}"

TERMS=(menu table kitchen course modifier chef dine_in kds recipe ingredient combo happy_hour waiter)

# Lines matching any of these are generic infra, not restaurant vocabulary --
# excluded before counting. Found by running an early, unfiltered pass and
# spot-checking a sample of "table" matches (the reconciliation's own
# ~800-of-810 estimate for that term alone, for the Rust/SQL side). The
# `<table`/`</table` exclusion is this script's own addition: it caught a
# second, equally large false-positive class the reconciliation didn't need
# to call out (it wasn't grepping TSX) -- plain HTML `<table>` markup used
# for generic UI grids (customers list, debt list, inventory list, none of
# them restaurant "seating table" domain concept), which dominated the
# frontend-side count the same way `CREATE TABLE` dominated the SQL side.
NOISE_PATTERN='CREATE TABLE|ALTER TABLE|DROP TABLE|table_exists|sync_queue|table_name|schema_migrations|PRAGMA table_info|information_schema|<table|</table|<Table'

# "table" gets special-cased, not a blanket whole-word match like every other
# term. It's an irreducibly overloaded word in this codebase: generic
# database noun (loop variables literally named `table`, log lines like
# "table 'X' does not exist", migration helpers iterating "every table") is
# structurally indistinguishable from the real restaurant-seating-table
# domain concept by regex alone -- even after every NOISE_PATTERN exclusion
# above, "table" alone still measured 450+ hits, dominated by migration
# infrastructure prose, not settling anywhere near a trustworthy signal.
# Rather than accept a noisy blanket count for this one term (which would
# make the whole ratchet's total meaningless -- one term swamping the other
# twelve), this narrows "table" to the specific identifiers the
# reconciliation manually verified as genuinely restaurant-domain: the SQL
# `tables` table itself, and the CRUD surface built on it
# (rename/delete/merge_tables, transfer_order, split_bill, the two modal
# component names). Revisit this list by hand if the real domain surface
# changes -- it is deliberately curated, not derived mechanically like the
# other twelve terms.
TABLE_TERM_PATTERN='\btables\b|rename_table|delete_table|merge_tables?|MergeTablesModal|TransferOrderModal|transfer_order|split_bill|table_id'

total=0
declare -A per_term
report=""

for term in "${TERMS[@]}"; do
    if [ "$term" = "table" ]; then
        matches=$(
            {
                grep -rnE "$TABLE_TERM_PATTERN" "$SRC" --include='*.ts' --include='*.tsx' 2>/dev/null || true
                grep -rnE "$TABLE_TERM_PATTERN" "$RUST_SRC" --include='*.rs' 2>/dev/null || true
            } | grep -Ev "$NOISE_PATTERN" || true
        )
    else
        matches=$(
            {
                grep -rnEwi "$term" "$SRC" --include='*.ts' --include='*.tsx' 2>/dev/null || true
                grep -rnEwi "$term" "$RUST_SRC" --include='*.rs' 2>/dev/null || true
            } | grep -Ev "$NOISE_PATTERN" || true
        )
    fi
    count=0
    if [ -n "$matches" ]; then
        count=$(echo "$matches" | grep -c .)
    fi
    per_term["$term"]=$count
    total=$((total + count))
    report="${report}${term}: ${count}\n"
done

echo "Vocabulary-leak ratchet -- restaurant-specific terms in kernel-territory source:"
echo -e "$report"
echo "TOTAL: $total"

if [ "${1:-}" = "--update" ]; then
    {
        echo "# vocab_ratchet baseline -- generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo -e "$report"
        echo "TOTAL: $total"
    } > "$BASELINE_FILE"
    echo "Baseline updated: $BASELINE_FILE"
    exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
    echo "No baseline found at $BASELINE_FILE -- run with --update to create one."
    exit 0
fi

baseline_total=$(grep -E '^TOTAL:' "$BASELINE_FILE" | grep -oE '[0-9]+' || echo "")
if [ -z "$baseline_total" ]; then
    echo "Baseline file exists but has no parseable TOTAL line -- run with --update to regenerate."
    exit 0
fi

echo "Baseline TOTAL: $baseline_total"

if [ "$total" -gt "$baseline_total" ]; then
    echo "RATCHET FAILED: restaurant-vocabulary count went up ($baseline_total -> $total). New restaurant-specific code is leaking into kernel territory -- either isolate it into vertical-pack-shaped code, or run with --update if this increase is deliberate and reviewed."
    exit 1
fi

echo "OK: restaurant-vocabulary count did not increase ($total <= $baseline_total)."
exit 0
