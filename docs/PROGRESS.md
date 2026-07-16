# PROGRESS.md — SPRINT_01_multitenant_trust_boundary_v3.md

**Last updated:** 2026-07-16, after Batch 3b (partial -- payment atomicity + zombie sweep +
staff CRUD; the remaining command groups are an explicit, honest carry-forward, not a hidden gap).
**Method:** percentages reflect what's implemented AND tested, not what's designed/planned.
A phase at 100% means its own stated Definition of Done is met; a phase with sub-scope
(e.g. "N of ~150 commands") is intentionally not rounded up.

## Batch 3b status: real numbers, not 150/150

You (2026-07-16) confirmed the full sprint scope for 3b (every remaining command group, payment
atomicity, the zombie-table sweep, `check-no-sql-in-frontend.sh` blocking, kysely/tauri_plugin_sql
removal) and, when asked how to sequence work of this size responsibly, chose "prioritized slice
now, rest next session." What that produced, honestly:

**Done this pass, full quality, tested:**
1. Zombie-table sweep (below) -- confirmed no other table can be silently resurrected.
2. Payment atomicity -- `take_payment_v3`, ONE transaction, kill-9 test included (T1.9's explicit
   critical item).
3. Staff CRUD -- `staff/page.tsx` restored (was actively broken in the UI), `create_staff_v3`
   (already existed) now actually reachable, plus 3 new commands.

**Commands converted to the v3 scoped shape: 30 / 150** (up from 25). New this pass:
`take_payment_v3`, `list_branches_v3`, `list_staff_v3`, `update_staff_profile_v3`,
`set_staff_active_v3`.

**NOT done this pass -- explicit, not hidden:** menu CRUD, inventory, shifts, finance, debt,
loyalty, settings, reports, and the 4 remaining drift-group pages (customers, PO tab, delivery,
printer.ts) are UNCHANGED from Batch 3a -- still `getDb()`/old commands. `check-no-sql-in-
frontend.sh` cannot be flipped to blocking yet (132 real frontend SQL references remain, see
below) and kysely/`tauri_plugin_sql` cannot be removed from `package.json` yet (still load-bearing
for every one of those unconverted pages). Both are next-session work, explicitly, not silently
dropped requirements.

## Zombie-table sweep (Decision, requested explicitly after the `users` incident)

Audited `SCHEMA_SQL` in `lib.rs` (37 `CREATE TABLE IF NOT EXISTS` statements) table-by-table
against the real `0001-0003` migrations: **36 of 37 are already created by the real migration
path before the frontend ever loads** (confirmed by diffing `grep`'s table-name output from both
sources). The 37th, `attendance`, is now created deterministically by Migration D (Batch 3a) before
the frontend gets a chance too. **Conclusion: every `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL` is
dead code today** -- none of them can fire, because Rust's `init_db()` always wins the race now.
`users` was the only one that used to matter (removed in the fresh-install bugfix, above).
**Not yet removed**: the `tauri_plugin_sql` plugin registration and the `kysely` dependency
themselves -- both are still load-bearing for the 132 real frontend SQL references that remain
(see above). Removing the plugin now would break every page still on the old path. This is the
literal next step once command conversion reaches zero remaining `getDb()` call sites.

## Payment atomicity (T1.9's explicit critical acceptance criterion)

`repo::Repo::take_payment` -- order status event/UPDATE, `payments` insert (with `_minor` money
columns populated at write time, same rule as `create_order`), `tables` release, optional
`debt_entries` write, and the `order_current` projection rebuild are all plain
`self.conn.execute` calls inside ONE method; `commands_v3::take_payment_v3` wraps the whole call in
one `rusqlite::Transaction` and commits exactly once, with the audit entry in the same transaction.
Refuses out-of-scope orders (`RepoError::OrderOutOfScope`) and double-payment
(`RepoError::OrderAlreadyPaid`) before writing anything.

**The kill-9 test** (`kill_9_mid_payment_never_leaves_a_partial_payment`): performs every write
`take_payment` does inside a real transaction, then drops the transaction WITHOUT calling
`commit()` -- rusqlite rolls back an uncommitted `Transaction` on `Drop`, which is exactly what
happens to SQLite's in-flight journal when a process is killed before a commit lands. Re-opens a
fresh connection afterward (simulating app restart post-crash) and asserts: order still PENDING,
table still OCCUPIED, zero payment rows. Never a PAID order on an OCCUPIED table; never a payment
without an order.

## Staff CRUD (was actively broken in the UI, not just architecturally impure)

`staff/page.tsx`'s employee list/create/edit/deactivate now call `list_staff_v3`,
`create_staff_v3` (existed since Batch 1, was simply unreachable from the UI), the new
`update_staff_profile_v3`, and `set_staff_active_v3`. `list_branches_v3` (new) lets an Owner pick a
`target_branch_id` when creating staff.

**Explicit, stated scope reduction**: `staff` has no `email`/`phone`/`photo_path`/`cv_path`/
`qr_code` columns -- the old employee form collected all of these. Removed those fields from the
form (not left inert and silently non-persisting) and dropped the `password` field entirely (login
is PIN-only now; every staff member needs a working PIN to log in, not just managers, so the PIN
field is now required on create, not optional). Creatable roles narrowed to
CASHIER/MANAGER/OWNER/KITCHEN -- ADMIN/ACCOUNTANT no longer exist as assignable roles (Migration C
folded both into MANAGER permanently); PLATFORM/SERVER aren't offered by this UI. Shifts/attendance
tabs on this same page are UNCHANGED (still `getDb()`) -- only the employees tab was in scope.

## `check-no-sql-in-frontend.sh`: fixed a bug that made it lie

The script's own regex used `\s` and unescaped quotes without `grep -E` -- not valid in `grep`'s
default POSIX BRE mode. It silently never matched anything and printed "OK" unconditionally,
regardless of how many violations actually existed. **It had been reporting green while 119-132
real `getDb()`/kysely references existed the whole time.** Fixed by adding `-E`. Still exits 0 on
violations (not flipped to blocking) -- 132 real references remain; flipping it now would break
every dev/CI run for reasons unrelated to a regression. Flip it once the count is genuinely zero.

## Fresh-install bugfix (found by hand-test, not by the automated suite)

A hand-test of the dev build on a genuinely fresh database found: **the setup wizard failed with
"table users has no column named username"** — the app could not create an owner on a clean install,
making it unusable from a fresh db. All 30 automated Rust tests were green at the time. Root-caused
and fixed:

**Step 1 — grep for every remaining frontend reference to `users`, requested verbatim:**
```
$ grep -rn '"users"\|invoke(.setup_owner.\|invoke(.needs_setup.\|selectFrom("users")\|insertInto("users")\|updateTable("users")\|deleteFrom("users")' src/
src/app/staff/page.tsx:171:      const rows = await db.selectFrom("users").selectAll().orderBy("name", "asc").execute();
src/app/staff/page.tsx:343:          .updateTable("users")
src/app/staff/page.tsx:350:          .insertInto("users")
src/app/staff/page.tsx:369:          (db.updateTable("users") as any).set({ qr_code: url }).where("id", "=", newId).execute().catch(() => {});
src/app/staff/page.tsx:386:        .updateTable("users")
src/app/staff/page.tsx:401:        .updateTable("users")
src/lib/permissions.ts:16,22,43: icon: "users"  -- an icon NAME string, unrelated to the table
```
**Finding: `SetupWizard.tsx`/`authStore.ts` were NOT among the survivors** — they already called
`setup_owner_v3`/`needs_setup_v3` (verified by re-reading both files in full). The only genuine
survivor is `staff/page.tsx`'s CRUD, already known and documented as broken in Batch 3a's PROGRESS
entry. So the reported crash could not come from a direct frontend `users` reference.

**Step 2 — actual root cause, found by reading `SCHEMA_SQL` in `lib.rs`:** `tauri_plugin_sql`'s own
lazy migration (a SEPARATE SQLite connection from Rust's `init_db()`, registered once and run the
FIRST time any frontend page calls `getDb()`) still had `CREATE TABLE IF NOT EXISTS users (...)` —
with no `username` column, matching the real `0001_init.sql`, NOT `0002_reconcile.sql`'s later
`ALTER TABLE users ADD COLUMN username`. On a fresh install: Rust's `init_db()` runs first and its
Migration C drops the real (`username`-having) `users` table entirely; the frontend then loads and
its FIRST `getDb()` call resurrects a bare, incomplete `users` table via this exact `IF NOT EXISTS`
block, since the real one is now gone and the check passes. Any later code expecting the full shape
(the OLD `setup_owner` command, before Decision A removed it, previously worked around this because
`migrate::run_migrations` had already run first and created `users` for real -- Decision A changed
that guarantee for the first time). **Fix: removed `CREATE TABLE IF NOT EXISTS users` from
`SCHEMA_SQL` entirely**, not patched to add `username` back — resurrecting a zombie `users` table
at all is the actual defect; `staff` is the only identity table now, and any code still reaching for
`users` (i.e. `staff/page.tsx`, already flagged) should fail loud (`no such table`), not silently
succeed against a half-broken shape.

**Step 3 — the test that would have caught this, added:**
`fresh_install_needs_setup_then_setup_owner_then_login_never_touches_users` — chains the actual
first-run sequence (0 owners exist -> bootstrap one via the same `Repo::create_staff` call
`setup_owner_v3` makes -> log in via the same scan-and-verify logic `login_pin_v3` uses) against a
genuinely fresh, non-legacy-fixture database, and asserts `sqlite_master` has no `users` table at
the start, middle, AND end of the chain. **Honest limitation, stated plainly**: this Rust test
cannot exercise `tauri_plugin_sql`'s own separate migration connection (that only runs inside the
real frontend/webview runtime) — it proves the Rust-side logic never touches `users`, but the actual
bug lived in `SCHEMA_SQL`'s table definition, a surface no `cargo test` run can reach. The real fix
for that is Step 2's removal; the test is defense-in-depth on the Rust side, not full coverage of
the original failure mode. **Also root-caused why 30/30 passed while the app was unusable**:
`needs_setup_v3` short-circuits to `false` under `cfg!(debug_assertions)`, which is always true for
`cargo test` builds — so no automated test had ever exercised the "0 owners -> wizard shows -> owner
created" path at all; every existing login test ran against a database `seed_default_staff` had
already pre-populated. The new test calls the underlying logic directly (bypassing the tauri State
wrapper, same as every other test in this file) specifically to exercise that condition for real.

**Commands converted to the v3 scoped shape: 25 / 150**
(Batch 1/2: `login_v3`, `create_branch_v3`, `create_staff_v3`, `update_staff_v3`, `list_orders_v3`,
`create_order_v3`, `update_order_status_v3`, `resolve_menu_price_v3`, `change_own_password_v3`.
Batch 3a: `login_pin_v3`, `setup_owner_v3`, `needs_setup_v3`, `logout_v3`, `create_customer_v3`,
`list_customers_v3`, `create_purchase_order_v3`, `list_purchase_orders_v3`, `create_driver_v3`,
`update_driver_location_v3`, `list_drivers_v3`, `create_printer_v3`, `list_printers_v3`,
`create_delivery_log_v3`, `update_delivery_status_v3`, `list_delivery_logs_v3`.)

## Batch 3a gate question, answered with real output before any code changed

`grep` confirmed the frontend called `login`/`login_with_pin` (the old, `users`-backed commands),
never `login_v3`. **Plain answer: no, a user could NOT log in through the running app** —
Decision A (Batch 2) dropped `users`, and nothing in the frontend called the v3 auth commands yet.
This was the first thing fixed in this batch, per instruction.

| Phase | Status | % | Evidence |
|---|---|---|---|
| T1.0a — Command inventory | ✅ Done, reviewed | 100% | `docs/plans/T1.0a_COMMAND_INVENTORY.md` |
| T1.0b — SCHEMA_V3.md | ✅ Done, reviewed, approved | 100% | `docs/plans/SCHEMA_V3.md` (v2, 7 blockers resolved) |
| T1.1 — EXPAND migration (A + B) | ✅ Done, tests green | 100% | `migrate_v3.rs`, 4 tests |
| Decision A — Identity migration (C) | ✅ Done, tests green | 100% | `staff` is the only identity table (Batch 2) |
| Batch 3a — Migration D (Decision B + Finding #3) | ✅ Done, tests green | 100% | See breakdown below |
| Login restored end-to-end | ✅ Done, tests green + tsc clean | 100% | See breakdown below |
| T1.2 — Command scaffold + scoped repo layer | 🟡 Infrastructure done, thin command coverage | **~60%** | See breakdown below |
| T1.3 — Permission matrix | 🟡 Mechanism done, enumeration partial | **~55%** | See breakdown below |
| T1.4 — Session, auth, scope resolution | 🟡 Core done, hardening incomplete | **~70%** | See breakdown below |
| T1.5 — Hash-chained audit log | ✅ Mechanism done and tested; signing explicitly deferred | **~80%** | Unchanged this batch |
| T1.6 — Money + append-only + two-layer menu | 🟡 Core mechanism done; price lists deferred | **~55%** | Unchanged this batch |
| T1.7 — Frontend migration | 🟡 Started (auth path + 5 drift groups' create paths converted) | **~15%** | See breakdown below |
| T1.8 — CONTRACT migration | ⬜ Not started | 0% | Depends on T1.6/T1.7 landing first |
| T1.9 — THE PROOF | ⬜ Not started as the formal gate | 0%* | *Scope isolation covered incidentally, not the full suite |

## Login restored end-to-end (100%)

- `commands_v3::login_pin_v3` — the actual mechanism `LoginPage.tsx` uses (a PIN pad, no
  username/password field exists in that UI at all). Scans active `staff` rows with a `pin_hash`
  set, same shape as the old (`users`-backed, now broken) `login_with_pin`.
- `commands_v3::setup_owner_v3` — bootstraps the very first OWNER into `staff` with no actor/session
  (there is none yet); guarded by "an OWNER already exists" as a hard refusal, not by authn/authz
  (there's nothing to authenticate against before the first OWNER exists).
- `commands_v3::needs_setup_v3` / `logout_v3` — same debug-mode shortcut and session-revoke shape as
  the old commands, retargeted at `staff`/`session_v3`.
- `security::revoke_session` (new) — the logout mechanism `logout_v3` needed; didn't exist before
  (nothing had needed to invalidate a `session_v3` row yet).
- **Removed** (not fixed in place): `login`, `login_with_pin`, `logout`, `check_auth`,
  `change_password`, `needs_setup`, `setup_owner`, `seed_default_users` — all `users`-backed, all
  fully superseded by the v3 equivalents. `check_auth` had zero frontend callers, confirmed by grep,
  so it was deleted outright rather than converted.
- `verify_manager_override` (existing Rust command, used by `shift/page.tsx`, `ManagerPinModal.tsx`,
  `VoidItemModal.tsx`) — **fixed** to query `staff` instead of `users`.
- **A pre-existing bug, found while fixing this, unrelated to the multi-tenant work**: the old
  `seed_default_users` never set a PIN hash on any seeded dev user at all, only a password hash —
  meaning dev-build PIN login was already broken before this sprint touched anything, since
  `LoginPage.tsx` is PIN-only. Fixed: the new `seed_default_staff` seeds a working `pin_hash` for
  all 4 dev roles (Owner `123456`, Manager `222222`, Cashier `333333`, Kitchen `444444`).
- **`authStore.ts` rewritten**: calls `login_pin_v3`/`setup_owner_v3`/`needs_setup_v3`/`logout_v3`/
  `change_own_password_v3`. `loginWithRust` (username/password) and the store's local `login()`
  setter were dead code (zero call sites, confirmed by grep) — removed, not ported. `SetupWizard.tsx`
  lost its username field (`staff` has no `username` column) — `setup_owner_v3` takes name+password+pin.
- **A wider regression discovered while fixing this** (not part of Decision B's named list, but a
  direct consequence of dropping `users`): 8 frontend files had 14 more direct Kysely references to
  `users` beyond the auth path — `ManagerPinModal.tsx`/`VoidItemModal.tsx` (client-side password
  verification against the dropped table — also a pre-existing security hole per `FEATURE_TRUTH.md`,
  fixed the same way `shift/page.tsx` already was: routed through `verify_manager_override` instead,
  so the hash never reaches the renderer at all), `inventory/page.tsx` (2 joins), `reports/page.tsx`
  (1 join), `branches/page.tsx` (2 counts), `ai/page.tsx` (1 join) — all fixed, `users` → `staff`.
  Added a minimal `StaffTable` Kysely type (`db/types.ts`) so these compile against the real schema.
  **`staff/page.tsx` (the staff CRUD page itself) is the one NOT fully fixed** — its read-only
  shift/attendance joins were retargeted at `staff`, but its create/update/list-all paths still
  `insertInto`/`updateTable`/`selectFrom("users")` directly, and are left broken. Reason stated
  plainly: `staff`'s schema is materially different (no `email`/`phone`/`photo_path`/`cv_path`/
  `qr_code`, `pin_hash` not `manager_pin_hash`, a `role_rank` + branch/tenant scope with a CHECK
  constraint) — a mechanical table-name swap would either silently drop fields or violate the
  constraint. The correct fix is routing through `create_staff_v3`/`update_staff_v3` (which already
  exist and already handle all of this correctly), which is real T1.7 frontend-migration work, not a
  one-line rename. Flagged here as the next concrete T1.7 item, not silently left for someone to
  rediscover.
- Tests: `login_pin_v3_authenticates_against_staff_and_rejects_wrong_pin`,
  `setup_owner_v3_bootstraps_first_owner_and_refuses_a_second`.

## Migration D — Decision B's 5 groups + Finding #3 (100%)

`migrate_v3.rs::run_drift_fix_migration` (version 7), additive only, wired into `init_db()` after
Migration C:

- **DRIFT_REPORT.md Findings #2/#5, the 5 named groups**: added every column those findings listed
  as missing — `customers` (address/birthday/last_order_at/loyalty_points/notes), `purchase_orders`
  (created_by/notes — `branch_id` already existed, added generically by Migration A since
  `purchase_orders` is a `TENANT_BRANCH_TABLES` entry), `drivers` (current_lat/current_lng/
  license_number/vehicle_plate), `delivery_logs` (assigned_at/picked_up_at/delivered_at/failed_at),
  `printers` (drawer_pulse_ms/is_primary/is_secondary/vendor_id/product_id). Unlike Finding #1's fix
  (never reference the column), these are real, wanted fields — the fix here is "make the column
  exist", verified column-by-column against `PRAGMA table_info` in
  `test_drift_fix_migration_adds_missing_columns_and_creates_scoped_attendance`.
- **Finding #3, `attendance`'s creation-race**: **decision made and stated, per instruction** —
  Migration D creates `attendance` itself, deterministically, right here, rather than a repo-layer
  just-in-time backfill. Reasoning: a migration-time fix is one function that runs once; a JIT
  backfill would need to run (or at least probe) on every future repo call against every legacy
  table, forever. Created with `tenant_id`/`branch_id` `NOT NULL` from creation (zero pre-existing
  rows, no backfill needed) and `user_id REFERENCES staff(id)`, not the dropped `users(id)` the old
  `SCHEMA_SQL` definition used. If the frontend's lazy path already won the race on a given install,
  Migration D scopes that existing table instead of recreating it (same `add_column_if_missing` +
  backfill pattern as every other legacy table).
- Test: `test_drift_fix_migration_adds_missing_columns_and_creates_scoped_attendance` — asserts every
  listed column exists, `attendance` exists and is scoped, its FK targets `staff` not `users`, and a
  tenant-scoped query against it succeeds (the exact failure Finding #3 predicted would happen once
  T1.2's scoping landed).
- New repo layer (`repo.rs`): `create_customer`/`list_customers` (tenant-only, no branch destructure —
  `customers` is a `TENANT_ONLY_TABLES` entry), `create_purchase_order`/`list_purchase_orders`,
  `create_driver`/`update_driver_location`/`list_drivers`, `create_printer`/`list_printers`,
  `create_delivery_log`/`update_delivery_status`/`list_delivery_logs`. All creates derive tenant_id/
  branch_id from the caller's own `Scope` (never a client-supplied argument — same pattern as
  `create_order_v3`, nothing here is spoofable). `update_delivery_status` stamps only the timestamp
  column matching the NEW status (picked_up_at/delivered_at/failed_at), never touches one a prior
  transition already set — append-only in spirit, same principle as T1.6's order status events.
- New commands (`commands_v3.rs`), one `Permission` per group rather than per command
  (`ManageCustomers`/`ManagePurchaseOrders`/`ManageDrivers`/`ManagePrinters`/`ManageDelivery` — a
  scope decision to keep the enum from growing by ~15 variants for ~15 commands; stated, not hidden).
- Test: `drift_broken_groups_create_and_list_round_trip_through_the_previously_missing_columns` —
  creates + lists through all 5 groups in one pass, asserting every previously-missing column
  round-trips (address/notes on a customer, created_by/notes on a PO, license_number/vehicle_plate/
  current_lat/lng on a driver, all 4 delivery timestamp columns progressing ASSIGNED → PICKED_UP →
  DELIVERED with none overwritten, drawer_pulse_ms/is_primary/vendor_id/product_id on a printer).

**Not done (explicit scope decision):** the frontend pages for 4 of the 5 groups
(`customers/page.tsx`, `inventory/page.tsx`'s PO tab, `deliveryService.ts`/`delivery/page.tsx`,
`printer.ts`) still call `getDb()` directly rather than the new v3 commands — Migration D's column
fix alone already makes their EXISTING Kysely code work again (verified: the missing columns were
the only thing broken about those specific read/write paths, once `users` joins were separately
fixed above), so the DoD's "every feature that was broken now works" is met through the schema fix,
not a full command-layer rewire. The v3 commands built this batch are the correct target for that
rewire and are ready to receive it — wiring all 4 pages' full CRUD UI to them is real, sizable T1.7
frontend work (each page has its own form validation, detail views, CSV export, etc.) that wasn't
attempted in this batch to avoid rushing UI changes in files not fully read. Flagged as the next
concrete T1.7 scope, not silently deferred.

## T1.2 breakdown (~62%)

**Done:** command shape (`authn → resolve Scope → authz → validate → repo → audit → commit`)
followed by all 6 new commands this batch (`take_payment_v3`, `list_branches_v3`, `list_staff_v3`,
`update_staff_profile_v3`, `set_staff_active_v3`, plus `create_staff_v3` finally reachable).

**Not done:** of the ~150 commands identified in T1.0a's inventory, **30 exist** in the new scoped
shape. The remaining ~120 (menu CRUD, inventory, shifts, debt, finance, loyalty, settings, reports,
and the 4 drift-group pages) still run as direct `getDb()` Kysely calls or old commands -- explicit
carry-forward for next session, listed in full at the top of this file.

## T1.3 breakdown (~57%)

**Done:** `Permission` grew from 12 to 13 variants (`TakePayment`, Cashier rank), full RBAC matrix
test updated and still exhaustive (13 permissions × 6 roles).

**Not done:** same as before — `ARCHITECTURE_V3.md` §2's full table has more actions than exist yet;
each future command adds its own permission(s) as built.

## T1.4 breakdown (~70%, unchanged this batch)

No auth-mechanism changes this pass. Idle-timeout enforcement, rate-limiting on `login_pin_v3`,
session-to-device re-verification per call — all still frontend/T1.7 concerns.

## T1.7 breakdown (~20%)

**Done:** the auth path (unchanged from 3a) plus `staff/page.tsx`'s employees tab (this batch) --
list/create/edit/deactivate all call v3 commands now, not raw SQL.

**Not done:** `staff/page.tsx`'s shifts/attendance tabs (untouched, still `getDb()`), and the 4
drift-group pages (customers, PO tab, delivery, printer.ts) — explicit next-session items.

## Known gaps carried forward (not fixed this batch, tracked explicitly)

1. **~120 commands still on the old path** — menu CRUD, inventory, shifts, finance, debt, loyalty,
   settings, reports, and the 4 drift-group pages. Explicit next-session scope, detailed above.
2. **Ed25519 audit signing** (T1.5) and **versioned price lists** (T1.6) — unchanged, still deferred.
3. **~25 legacy tables** still rely solely on the Rust-level `assert_scope_populated` check — unchanged.
4. **`login_v3`/`login_pin_v3` have no rate-limiting** — flagged, not fixed.
5. **`check-no-sql-in-frontend.sh` cannot be flipped to blocking yet** — 132 real references remain.
6. **`kysely`/`tauri_plugin_sql` cannot be removed from `package.json` yet** — still load-bearing.
7. **Staff photo/CV upload and QR-code persistence are gone** (Batch 3b, stated scope reduction) —
   `staff` has no columns for them; dropped from the UI, not silently left non-functional.

## Test evidence (this batch)

**34/34 Rust tests pass** (31 carried over + 3 new: `take_payment_v3_commits_order_payment_table_
and_projection_atomically`, `kill_9_mid_payment_never_leaves_a_partial_payment`,
`staff_crud_list_update_profile_and_toggle_active`). `cargo build` (full binary, debug profile)
succeeds. `cargo check` clean. `cargo clippy --lib --tests -- -D warnings` clean.
`npx tsc --noEmit` clean.

**Hand-test confirmed by you** (2026-07-16): fresh db → create owner → enter app → restart → PIN
pad → login → order persists. Green — this is what authorized 3b to start.

## Next-session punch list (explicit, in priority order)

1. Menu CRUD, inventory, shifts — the 3 remaining core POS-adjacent groups.
2. Finance, debt, loyalty, settings, reports.
3. The 4 drift-group pages' frontend rewire (customers, PO tab, delivery, printer.ts) — backend
   commands already exist from Batch 3a, only the frontend call sites remain.
4. `staff/page.tsx`'s shifts/attendance tabs.
5. Once (1)-(4) bring `getDb()` call sites to zero: flip `check-no-sql-in-frontend.sh` to blocking,
   remove `kysely` + `tauri_plugin_sql` from `package.json`, remove the plugin registration in
   `lib.rs`'s `tauri::Builder`.
6. Full RBAC matrix re-verified at ~150 commands.
7. T1.9 (the formal proof) starts only after all of the above.
