# SPRINT 00 — Truth & Hardening

**Duration:** 3 days
**Goal:** Know exactly what we have, stop shipping a backdoor, and make the repo safe to refactor.
**Blocks:** everything. Do not start S1 until S0 is green.

> Read `CLAUDE.md` and `ARCHITECTURE_V2.md` first.

---

## T0.1 — Feature truth audit

Produce `docs/FEATURE_TRUTH.md`. For **every claim in the current README**, find the code that
implements it and classify honestly:

| Status | Meaning |
|---|---|
| `WORKS` | Implemented, exercised, no known gap. Cite file:line. |
| `PARTIAL` | Happy path only. List what's missing. |
| `STUB` | UI exists, no logic behind it. |
| `FICTION` | Claimed in the README, does not exist in code. |

Output format, one row per README claim:

```
| Claim | Status | Evidence (file:line) | Gap |
```

Rules:
- Do **not** fix anything in this task. Only observe and report.
- Do **not** be generous. A button that opens a modal that calls nothing is `STUB`, not `PARTIAL`.
- Specifically verify, because I suspect them: split/merge/transfer bill, purchase order receive
  flow, ESC/POS printing over network, barcode scanner, happy hour, combo pricing, recipe-based
  stock depletion, the AI page, cloud sync, backup/restore.

**Then rewrite `README.md`** to describe only `WORKS` and `PARTIAL`. Move everything else to
`docs/ROADMAP.md` under "Not built yet." A README that overstates is a P0 bug.

**Acceptance:** I can hand `FEATURE_TRUTH.md` to a stranger and they can predict, correctly, what
happens when they click any button in the app.

---

## T0.2 — Remove the shipped backdoor

- [ ] Delete the four seed users (`owner`/`manager`/`cashier`/`kitchen`, password `admin123`).
- [ ] Replace with a **first-run setup wizard**: create the owner account, force a password
      (min 10 chars) and a 6-digit POS PIN. No account exists before the wizard completes.
- [ ] Seed users may still exist in `dev` builds only, behind `#[cfg(debug_assertions)]`, with a
      loud banner in the UI.
- [ ] `debug/page.tsx` compiled out of release builds entirely (not just route-guarded).
- [ ] Set a real CSP in `tauri.conf.json`. `null` is not a CSP. Local SQLite access does not require
      disabling it — find the actual directive you need.
- [ ] Remove the credentials table from the README.

**Acceptance:** a release build, fresh install, has zero accounts and zero known passwords.

---

## T0.3 — Migration framework

Ad-hoc `ALTER TABLE` in `init_db()` will destroy a restaurant with 8 months of orders. Replace it.

- [ ] `schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER, checksum TEXT)`
- [ ] Migrations are numbered files: `migrations/0001_init.sql`, `0002_....sql`. Each has `-- up`.
- [ ] Runner applies pending migrations **inside a single transaction per migration**, verifies
      checksum of already-applied ones, refuses to start if a checksum changed.
- [ ] **Pre-migration snapshot**: copy the DB file before applying anything. On failure, restore and
      surface a clear error. Never leave a half-migrated database.
- [ ] Fold the existing ad-hoc ALTERs into `0001` (fresh installs) plus a `0002` reconciliation
      migration for any device already in the wild (there are none yet — confirm this).

**Acceptance test** (`cargo test migrations`):
1. Build a fixture DB with 6 months of synthetic orders on schema v1.
2. Run every migration up to HEAD.
3. Assert: row counts preserved, sum of all order totals unchanged, no FK violations,
   `PRAGMA integrity_check` = ok.

---

## T0.4 — CI

`.github/workflows/ci.yml` — must run on every push, must block merge:

```
pnpm typecheck
pnpm lint
pnpm test
cargo fmt --check
cargo clippy -- -D warnings
cargo test
scripts/check-no-country-in-core.sh     # the grep from ARCHITECTURE_V2 §3
scripts/check-no-sql-in-frontend.sh     # grep for getDb/kysely/plugin-sql under src/
```

The last two will **fail today**. That's correct — they're the guardrails for S1. Wire them up now
as `continue-on-error: true`, and flip them to blocking at the end of S1.

---

## T0.5 — Chaos test harness

`pnpm test:chaos`:
- Spawn the app against a temp DB.
- Drive N=200 randomized order+payment cycles.
- At a random instruction inside each write transaction, `kill -9` the process.
- Restart, run `PRAGMA integrity_check`, and assert:
  - the DB is not corrupt
  - every payment that returned success to the caller is present
  - no payment is present that never returned success
  - the audit chain verifies

This will fail today. Do not fix it in S0 — just make the harness exist and record the failure rate
in `docs/FEATURE_TRUTH.md`. S2 fixes it.

---

## Definition of done for S0

- [ ] `FEATURE_TRUTH.md` exists and is honest
- [ ] `README.md` contains no `FICTION`
- [ ] Fresh release install has no default accounts
- [ ] `cargo test migrations` green
- [ ] CI runs and is green on the non-guardrail checks
- [ ] `pnpm test:chaos` exists and its current failure rate is documented
