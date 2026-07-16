# DRIFT_REPORT.md — schema.sql / SCHEMA_SQL vs. the real applied database

**Read-only. No fixes applied.** Generated 2026-07-16 by loading all three schema
sources into real SQLite databases and diffing `PRAGMA table_info` per table
(not by eyeballing text — the three sources disagree in enough places that a
manual read undercounts the drift).

## Method and why it matters: there are TWO migration paths, and they race

This app boots with two independent, uncoordinated schema-initialization paths
against the **same** `zaeem_pos.db` file:

1. **Rust-side (`.setup()` hook, `lib.rs`)** — runs `init_db()` → `migrate::run_migrations`
   (T0.3 framework, embedded `0001_init.sql` + `0002_reconcile.sql` +
   `0003_schema_v2.sql`, now also my T1.1 Migrations A/B). This runs **first**,
   before the webview/frontend exists at all.
2. **Frontend-side (`tauri_plugin_sql` plugin)** — registers one migration,
   `version: 1`, whose SQL body is the `SCHEMA_SQL` Rust constant (a large
   `CREATE TABLE IF NOT EXISTS ...` block matching the *original* pre-T0.3
   schema). This does **not** run at app launch — it runs lazily, the first
   time the frontend calls `Database.load()` (i.e., the first `getDb()` call
   from any React component).

Because path 1 always runs first, and `CREATE TABLE IF NOT EXISTS` is a
**complete no-op for any table that already exists** (SQLite does not diff or
reconcile columns — it only checks the table name), path 2's migration can
only ever add columns to tables path 1 **never created**. For every table both
paths define, path 1 wins permanently, and any column present only in
`SCHEMA_SQL`/`schema.sql` (the frontend's Kysely type source) but absent from
`0001-0003` is **gone forever** on any install that has ever run path 1 —
which is every install, since it runs unconditionally in `.setup()`.

This is why the drift below is not cosmetic: the frontend code (and its
Kysely-generated types) were written against `schema.sql`, but the database
that code actually runs against is shaped by `0001-0003`. They have diverged.

---

## Finding #1 (critical): `orders.driver_id` — breaks ALL order creation on a fresh install

`orders` is created by `0001_init.sql` **without** a `driver_id` column.
`orderService.ts:59` (`createOrder`, called from every single order — dine-in,
takeaway, delivery, all of them) unconditionally includes `driver_id` in the
Kysely `.insertInto("orders").values({...})` call:

```ts
driver_id: driverId || null,
```

Kysely generates the literal column list from that object — it does not
silently drop unknown fields. On a database created via path 1 (i.e., **any
fresh install** of the app as it exists today), this INSERT fails with
`SQLite error: no such column: driver_id`, for every order, every time.

- **Breaks or loses data?** Breaks — hard SQL error, thrown, not caught by a
  `try`/`catch` anywhere in `createOrder` itself. No data is silently lost;
  the order simply never gets created and the cashier sees a failure. But
  this means **the POS's core function — taking an order — does not work at
  all** on a fresh install.
- **Which install paths hit it:** Every fresh install, unconditionally, from
  the very first order. This predates my T1.1 work — `migrate::run_migrations`
  (the T0.3 framework) was already wired into `.setup()` before this session
  started; T1.1 only added Migrations A/B *after* the already-broken 0001-0003.
- **Why it hasn't been noticed (hypothesis, not confirmed):** any device whose
  `zaeem_pos.db` file was created before the T0.3 framework existed, or by
  some other path that ran `SCHEMA_SQL` first, would already have `driver_id`
  and never see this. It would only surface on a genuinely new install.

---

## Finding #2 (high): `purchase_orders` — breaks PO creation and PO listing

Real schema (`0001_init.sql`) has: `id, supplier_id, status, total_cents,
created_at, received_at, sync_*`. Missing entirely: `branch_id`, `created_by`,
`notes`.

`inventory/page.tsx:1151` inserts `created_by: user?.id ?? "unknown"` into
`purchase_orders` on creation, and `:1212/:1220` **joins** on
`purchase_orders.created_by` when listing POs. Both the create path and the
read path reference a column that doesn't exist.

- **Breaks or loses data?** Breaks. PO creation fails outright (INSERT
  errors); if any PO rows exist from before this drift, the listing query
  (which joins on the missing column) would also fail, potentially making
  the whole Purchase Orders tab unusable, not just creation.
- **Install paths:** same as Finding #1 — any fresh install.

---

## Finding #3 (structural risk, not yet a bug): `attendance` table timing

`attendance` is defined in `SCHEMA_SQL`/`schema.sql` but **not created by
0001-0003 at all** — the whole table is absent from the T0.3 framework.
Because path 2 (`SCHEMA_SQL`) creates tables that don't already exist, and
`attendance` is one of the few tables path 1 never touches, `CREATE TABLE IF
NOT EXISTS attendance` in path 2 **does** eventually run and **does** create
the table — but only once, the first time any component calls `getDb()`,
which in practice happens very early (the POS screen itself loads via
`getDb()` on mount). So in real usage `attendance` most likely exists by the
time `staff/page.tsx`'s clock-in feature is reachable.

**The actual problem this creates is with my own T1.1 migration, not the app
today.** Migration A/B run inside `.setup()`, strictly before path 2 ever
gets a chance to create `attendance`. My migration already detects this and
skips `attendance` gracefully (logged, not a crash) — but that means
**`attendance` permanently never gets `tenant_id`/`branch_id` backfilled or
touched by Migration A at all**, because by the time it's created (moments
later, by path 2), Migration A has already run and recorded itself as
applied in `schema_migrations`. It will not run again.

- **Breaks or loses data?** Not today — clock-in/out currently works (no
  scoping exists yet to violate). This becomes a real bug the moment T1.2's
  scoped repo layer requires `tenant_id` on every table it touches, including
  `attendance`: rows created via path 2 will have no `tenant_id`/`branch_id`
  columns at all, and any scoped query against `attendance` will fail (column
  doesn't exist) rather than leak data.
- **Recommendation, not applied:** T1.2 needs an explicit "table appeared
  after Migration A already ran" handling path — either Migration A creates
  `attendance` itself (redundant with path 2, but deterministic and no longer
  race-dependent), or T1.2's repo layer runs a just-in-time backfill the first
  time it touches a table lacking scope columns. Flagging for the T1.2 design,
  not deciding here.

---

## Finding #4 (medium, silent-degradation, not silent data loss): `chain_config` missing four columns

Missing from real: `customer_display_baud`, `customer_display_port`,
`secondary_tax_rate_cents`, `service_charge_rate_cents`.

`taxCalculator.ts:66` reads chain_config with **`.selectAll()`** (`SELECT *`),
not an explicit column list, wrapped in a `try { ... } catch { ... }`. Because
`SELECT *` only returns columns that actually exist, this does **not** throw —
`config.secondary_tax_rate_cents` and `config.service_charge_rate_cents` are
simply `undefined` in the returned object.

- **Breaks or loses data?** Neither, cleanly — it's worse in one specific way:
  `secondaryTaxRateCents: undefined` flows into tax arithmetic. If a tenant
  ever configures a nonzero secondary tax or service charge rate (fields the
  Settings UI still shows, since the frontend doesn't know these columns are
  gone), every order's total calculation involving that rate would compute
  `NaN`, not throw — this is the one finding in this report closest to
  "silently wrong," though it manifests as a visibly broken total (`NaN`) on
  screen and on the receipt, not a quietly-wrong number that looks correct.
  Currency/base tax rate/tax mode are unaffected (those columns exist).
  Customer-display serial port config (`customer_display_port`/`_baud`) is
  simply unusable — the feature already reads as stub-quality elsewhere.
- **Install paths:** all fresh installs; effect only manifests if a
  secondary tax/service charge rate is actually configured.

---

## Finding #5 (high, same pattern as #1/#2, one line each): the remaining explicit-insert breaks

Same failure shape as Finding #2 — a frontend Kysely `.values({...})` call
references a column absent from the real schema, so the write hard-errors.
Confirmed by grep that each of these columns is referenced outside
`db/types.ts` (i.e., in actual query/form code, not just type definitions):

| Table | Missing column(s) | Referencing code | Feature broken |
|---|---|---|---|
| `customers` | `address`, `birthday`, `last_order_at`, `loyalty_points`, `notes` | `customers/page.tsx`, `loyalty/page.tsx` | Customer create/edit with any of these fields; loyalty point display sourced from this column |
| `drivers` | `current_lat`, `current_lng`, `license_number`, `vehicle_plate` | `delivery/page.tsx`, `DriverSelectModal.tsx`, `deliveryService.ts` | Driver create/edit; live location tracking |
| `delivery_logs` | `assigned_at`, `delivered_at`, `failed_at`, `picked_up_at` | `delivery/page.tsx`, `deliveryService.ts` | Delivery status-progression writes |
| `printers` | `drawer_pulse_ms`, `is_primary`, `is_secondary`, `vendor_id`, `product_id` | `printer.ts` | Printer config save (cash-drawer pulse timing, primary/secondary designation, USB vendor/product id matching) |
| `terminals` | `last_sync` | `branches/page.tsx` | Branch/terminal sync-status display |
| `combo_meals` | `is_active` | *(grep found no non-type reference — likely dead column, low/no risk)* | — |
| `loyalty_cards` | `is_active` | *(same — no non-type reference found)* | — |
| `suppliers`, `invoices`, `operational_costs`, `loyalty_transactions`, `notifications` | `address`/`notes`, `notes`, `description`, `description`, `link` respectively | not individually traced (time-boxed) | Likely same pattern: create/edit forms for these fields would hard-error; unconfirmed without per-file tracing |

`menu_items` has a matching gap the **other direction** — real DB already has
`is_combo`/`combo_original_price_cents`/`combo_description` (added by
`0002_reconcile.sql`), but `schema.sql` (the Kysely type source) doesn't
declare them. This is a TypeScript type gap only, not a runtime risk — the
columns exist, code just doesn't have compile-time types for them.

---

## Overall conclusion on the gate condition

**No confirmed active data loss** (no case found where a value is silently
overwritten, dropped, or corrupted after being accepted). What exists instead
is worse in a different way for Finding #1 specifically: **a fresh install of
this app cannot create a single order**, a hard, visible, unmissable failure
— not silent, but severe enough that it should be treated as an emergency
independent of this batch's sequencing. Findings #2 and #5 are the same
failure class on secondary features. Finding #4 is the only "quietly wrong
number" case, and it requires a non-default tax configuration to manifest.
Finding #3 is not a bug yet but will become one under T1.2's scoping if not
addressed explicitly there.

Per your instruction, proceeding to Batch 1 (T1.2 + T1.3 + T1.4).
