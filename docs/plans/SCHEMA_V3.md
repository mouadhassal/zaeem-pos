# SCHEMA_V3.md — T1.0b: The Target Schema

**Status: DRAFT v2 — review gate. No migration code written against this yet.**
**Authority chain:** `ARCHITECTURE_V3.md` (multi-tenant hierarchy, §1-§8) →
`ARCHITECTURE_V2.md` §2 (trust boundary, audit chain) and §4 (money model) →
`T1.0a_COMMAND_INVENTORY.md` (what queries this schema must serve) →
review decisions dated 2026-07-16 (role-rank permissions, two-layer settings) →
**revision decisions dated 2026-07-16, second pass (7 blockers/changes, all applied below).**

This is one migration, landing every concern at once — multi-tenancy, money, append-only,
sync, audit — because doing it in two passes means migrating the same 35 tables twice.
Per T1.1 the actual rollout is EXPAND → MIGRATE → CONTRACT; this document specifies the
**target end state** each table converges to, and what happens to existing data.

---

## 0. Non-goals (deliberately out of scope, per ARCHITECTURE_V3.md's discipline note)

This schema does NOT design: notifications, promo suggestions, raise/late detection,
inter-branch stock transfer, AI chat storage, hardware-scanner-specific tables. Those are
Phase 2. If a table below looks thin, that's often why — resist the urge to grow it here.

---

## 1. Identity & hierarchy tables (new)

```sql
CREATE TABLE tenant (
  id            TEXT PRIMARY KEY,          -- UUIDv7
  name          TEXT NOT NULL,
  base_currency TEXT NOT NULL,             -- the currency cross-branch reports roll up into (§5 blocker #2); NOT used for pricing or charging
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE branch (
  id            TEXT PRIMARY KEY,          -- UUIDv7
  tenant_id     TEXT NOT NULL REFERENCES tenant(id),
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL,             -- native to branch, per ARCHITECTURE_V3 §1/§4
  locale        TEXT NOT NULL DEFAULT 'ar-SY',
  timezone      TEXT NOT NULL DEFAULT 'Asia/Damascus',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- mutable-row sync columns (§6)
  updated_at_hlc TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  deleted_at     TEXT,
  rev            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE staff (
  id              TEXT PRIMARY KEY,        -- UUIDv7. Replaces `users`.
  tenant_id       TEXT NOT NULL REFERENCES tenant(id),
  branch_id       TEXT REFERENCES branch(id),   -- NULL only for OWNER (tenant-wide) or Platform
  role            TEXT NOT NULL CHECK(role IN ('PLATFORM','OWNER','MANAGER','CASHIER','KITCHEN','SERVER')),
  role_rank       INTEGER NOT NULL,        -- see §3.1 — denormalized for the repo-layer rank check
  name            TEXT NOT NULL,
  email           TEXT UNIQUE,
  pin_hash        TEXT,
  password_hash   TEXT,                    -- required for OWNER/MANAGER (back-office login), optional for POS-only staff
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_hlc  TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  deleted_at      TEXT,
  rev             INTEGER NOT NULL DEFAULT 1,
  CHECK ((role IN ('OWNER','PLATFORM') AND branch_id IS NULL) OR (role NOT IN ('OWNER','PLATFORM') AND branch_id IS NOT NULL))
);
```

`ACCOUNTANT` (present in the current `users.role` CHECK) is **dropped from the enum —
confirmed 2026-07-16.** Folded into `MANAGER` rank. Nothing in the T1.0a inventory found it
gated differently from `MANAGER`/`OWNER` in practice (`finance/page.tsx` treats them
identically). If accountant-specific scoping is needed later, it's a role addition (new rank
between Manager and Cashier), not a schema break.

`KITCHEN` stays; `SERVER` is added because ARCHITECTURE_V3 §1 lists it in the hierarchy
diagram even though no current UI role maps to it yet — added now so T1.2's role enum doesn't
need a second migration when table service differentiates from cashier.

---

## 2. Scope resolution

Per `ARCHITECTURE_V3.md` §3, the Rust type (not stored — computed at login from `staff`):

```rust
enum Scope {
    Platform,
    Tenant { tenant_id: Uuid },
    Branch { tenant_id: Uuid, branch_id: Uuid },
}
```

Resolution rule, driven entirely by `staff.role` + `staff.branch_id`:

| `staff.role` | `staff.branch_id` | Resolves to |
|---|---|---|
| `PLATFORM` | NULL | `Scope::Platform` |
| `OWNER` | NULL | `Scope::Tenant { tenant_id }` |
| `MANAGER` / `CASHIER` / `KITCHEN` / `SERVER` | NOT NULL | `Scope::Branch { tenant_id, branch_id }` |

The session token (T1.4) carries the resolved `Scope`, computed once at login, never
re-derived from client-supplied arguments. The repo layer (T1.2) takes this `Scope` on every
query and appends the matching `WHERE tenant_id = ?` / `WHERE tenant_id = ? AND branch_id = ?`
automatically — a query issued with no scope is refused at the repo layer, not just
unconventional.

### 2.1 Role rank (decisions #2, #3 — 2026-07-16)

```rust
fn rank(role: Role) -> u8 {
    match role {
        Role::Platform => 4,
        Role::Owner    => 3,
        Role::Manager  => 2,
        Role::Cashier | Role::Kitchen | Role::Server => 1,
    }
}
```

Two hard rules, enforced in Rust, not the frontend:

1. **Assignment rule** (`create_staff`, `update_staff`): `actor_rank > target_rank`, always.
   A Manager (rank 2) can create/edit Cashier/Kitchen/Server (rank 1) only — never another
   Manager, never Owner. An Owner (rank 3) can create/edit Manager and below. Platform can
   create/edit Owner and below. This closes the gap the T1.0a inventory found (any caller
   could assign any role).
2. **Permission inheritance rule** (fixes `force_close_shift`'s oversight, decision #3):
   higher ranks are supersets of every permission a lower rank holds, **within the same or
   broader scope**. `Permission → minimum_rank` lookup, not `Permission → Set<Role>` — a
   Manager having `ForceCloseShift` means Owner and Platform have it too, automatically,
   because `actor_rank >= minimum_rank(perm)` is the entire check. This is simpler than a
   per-role permission set AND structurally prevents the class of bug T1.0a found (a
   permission granted to Manager but silently absent from Owner).

`branch_id` forcing (decision #1, hard rule #2 from ARCHITECTURE_V3): `create_staff` called
by a Manager ignores any `branch_id` argument and forces `staff.branch_id = actor.branch_id`.
Called by Owner/Platform, `branch_id` is a required argument (must belong to their tenant).

---

## 3. Two-layer menu (per ARCHITECTURE_V3 §4)

```sql
CREATE TABLE menu_item_default (
  id                 TEXT PRIMARY KEY,     -- UUIDv7. Replaces `menu_items`.
  tenant_id          TEXT NOT NULL REFERENCES tenant(id),
  category_id        TEXT NOT NULL REFERENCES category(id),
  name               TEXT NOT NULL,
  price_minor        INTEGER NOT NULL,     -- Money, in tenant.base_currency — a SET NUMBER, never live-converted (see resolution rule below)
  cost_minor         INTEGER,
  barcode            TEXT,
  image_path         TEXT,
  is_combo           INTEGER NOT NULL DEFAULT 0,
  combo_original_price_minor INTEGER,
  combo_description  TEXT,
  recipe_id          TEXT REFERENCES recipe(id),
  is_active          INTEGER NOT NULL DEFAULT 1,
  updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE menu_item_override (
  branch_id       TEXT NOT NULL REFERENCES branch(id),
  item_id         TEXT NOT NULL REFERENCES menu_item_default(id),
  price_minor     INTEGER,       -- NULL = inherit default; branch price in the BRANCH's currency
  available       INTEGER,       -- NULL = inherit default (1/0 explicit override)
  updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (branch_id, item_id)
);
```

**Resolution at POS time (revised 2026-07-16 — blocker #2): `override.price_minor ?? default.price_minor`.**
No conversion function, no live FX lookup, ever. A menu price — whether the tenant default or
a branch override — is a set number, entered and stored in a fixed currency, charged exactly
as stored. FX conversion happens **only** at cross-currency reporting/rollup time (§5's
`base_amount`/`fx_rate` on the `MoneySnapshot` written when the order is charged), never when
displaying or charging a menu price.

This means the default (`tenant.base_currency`) is only directly usable by a branch whose own
`currency` equals `tenant.base_currency`. **A branch running a different currency than the
tenant base MUST have an explicit `menu_item_override` row (with `price_minor` set, not NULL)
for every sellable item** — there is no automatic fallback across currencies. This is a
data-integrity rule enforced in Rust (the command that resolves a POS-time price returns "item
unavailable at this branch" rather than silently converting), not a SQL `CHECK`, since it's a
cross-table condition SQLite can't express declaratively. The resolved price is **stamped onto
the order line as a `MoneySnapshot`** at sale time (§5) — a later price-list change never
rewrites a past order.

`category`, `combo_item`, `happy_hour_rule` follow the same tenant-default pattern
(`tenant_id`, no branch layer for now — no command in T1.0a needed branch-level category
overrides; add `category_override` later if that need materializes, don't build it
speculatively per §0).

---

## 4. Two-layer settings (decision #4 — 2026-07-16)

Same override pattern as §3, applied to what was the single `chain_config` singleton row.
Split by what's genuinely tenant-wide vs. branch-native vs. override-able:

```sql
CREATE TABLE tenant_settings (
  tenant_id                  TEXT PRIMARY KEY REFERENCES tenant(id),
  chain_name                 TEXT NOT NULL,
  tax_mode                   TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_mode IN ('inclusive','exclusive')),
  tax_rate_bps                INTEGER NOT NULL DEFAULT 0,   -- basis points; a RATE is not Money, no currency/scale needed
  secondary_tax_rate_bps      INTEGER NOT NULL DEFAULT 0,
  service_charge_rate_bps     INTEGER NOT NULL DEFAULT 0,
  updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE branch_settings (
  branch_id                  TEXT PRIMARY KEY REFERENCES branch(id),
  -- native to the branch, no tenant layer (physical/hardware facts):
  default_paper_width        INTEGER NOT NULL DEFAULT 80,
  auto_print_receipt         INTEGER NOT NULL DEFAULT 1,
  auto_print_kitchen         INTEGER NOT NULL DEFAULT 1,
  barcode_prefix             TEXT NOT NULL DEFAULT '',
  barcode_suffix             TEXT NOT NULL DEFAULT '',
  customer_display_port      TEXT,
  customer_display_baud      INTEGER NOT NULL DEFAULT 9600,
  -- overrides tenant_settings; NULL = inherit tenant default:
  tax_mode                   TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('inclusive','exclusive')),
  tax_rate_bps                INTEGER,
  secondary_tax_rate_bps      INTEGER,
  service_charge_rate_bps     INTEGER,
  updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
);
```

`currency`/`locale`/`timezone` are **not** here — they live directly on `branch` (§1) as
required, non-overridable-because-there's-nothing-to-override-from fields, per ARCHITECTURE_V3
§1's "Damascus branch and a future Erbil branch price in different currencies" example.

Resolution: `branch_settings.tax_rate_bps ?? tenant_settings.tax_rate_bps`, same `??` pattern
as the menu. `get_settings`/`update_settings` (existing Rust commands, per T1.0a) become
`get_effective_settings(branch_id)` (resolves both layers, Branch scope, any staff) and two
write commands: `update_tenant_settings` (Owner/Platform, Tenant scope) and
`update_branch_settings` (Manager+, Branch scope, only affects override + hardware fields).

---

## 5. Money

Per `ARCHITECTURE_V2.md` §4, verbatim types:

```rust
pub struct Money { pub minor_units: i64, pub currency: Currency, pub scale: u8 }
pub struct MoneySnapshot {
    pub amount: Money, pub base_amount: Money,
    pub fx_rate: Decimal, pub fx_source: FxSource,   // MANUAL | DAILY_SHEET | API | UNKNOWN
    pub denom_epoch: u32,
}
```

**`scale` is derived from `currency`, never hardcoded (blocker #1, 2026-07-16).** Per
`ARCHITECTURE_V2.md` §3, market packs expose a `MoneyPolicy` trait; its `scale_for(currency)`
lookup is the single source of truth:

```rust
trait MoneyPolicy {
    fn scale_for(&self, currency: Currency) -> u8;   // SYP -> 0, USD -> 2, ...
}
```

Anywhere this document or the migration writes a `scale` value, it means "call
`MoneyPolicy::scale_for(currency)`," never a literal. This applies equally to backfilled rows
(§10) and to new rows written by Rust commands going forward — there is exactly one place scale
is decided, and it is keyed off the row's own `currency` column, not asserted by whoever wrote
the migration script.

Every transactional row (order, order_item, payment, void, debt_entry) that currently has a
bare `_cents INTEGER` gets the full `MoneySnapshot` column set instead of one integer:

```sql
-- applied to: orders.total, order_items.unit_price, payments.amount, debt_entries.amount, etc.
{col}_minor          INTEGER NOT NULL,     -- Money.minor_units, in the transaction's own currency
{col}_currency        TEXT NOT NULL,
{col}_scale           INTEGER NOT NULL,
{col}_base_minor       INTEGER NOT NULL,    -- converted to tenant base currency at tx time
{col}_fx_rate          TEXT NOT NULL,       -- Decimal, stored as string (SQLite has no fixed-point type)
{col}_fx_source        TEXT NOT NULL CHECK({col}_fx_source IN ('MANUAL','DAILY_SHEET','API','UNKNOWN')),
{col}_denom_epoch      INTEGER NOT NULL DEFAULT 2   -- current epoch per the 2026-01-01 SYP redenomination
```

Applied concretely to `orders`: `subtotal_*`, `tax_*`, `discount_*`, `total_*` (4 sets × 6
columns = 24 new columns on `orders` alone). `order_items` gets one set (`unit_price_*`).
`payments` gets one set (`amount_*`, `change_*`). `debt_entries` gets one set (`amount_*`).

**Design choice (item #6, decided 2026-07-16): wide columns on `orders`, not a tall
`order_money(order_id, role, minor, currency, scale, base_minor, fx_rate, fx_source,
denom_epoch)` child table with one row per money role.** Reasoning:

- **Hot path, fixed cardinality.** `orders` is read on every POS screen paint, every receipt,
  every KDS poll, every report — it is the single most frequently read row shape in the app.
  The four money roles it needs (subtotal/tax/discount/total) are accounting fundamentals that
  have not changed shape in the lifetime of double-entry bookkeeping; this is not an
  open-ended, growing set the way `operational_cost` categories might be. A wide row reads in
  one lookup with no join, which matters when the read happens on every frame of a live POS
  screen, not just occasionally.
- **Atomicity of the money-critical transaction.** T1.9's payment-atomicity proof requires
  `take_payment` to be one Rust transaction with a kill-9-safe outcome 100/100 times. A single
  `orders` row with 24 columns is one `INSERT`; a tall table is 4 `INSERT`s that must commit
  together — more surface area for the exact failure mode (`kill -9` mid-write) T1.9 exists to
  rule out, for no benefit here since the four roles never vary in number.
- **When the tall pattern is right instead:** anywhere the number of money-bearing rows per
  parent is genuinely open-ended or user-defined — e.g. `operational_cost` (arbitrary
  categories), `price_list_item` (arbitrary count of menu items) — already uses one-row-per-item
  shapes in this document (§5, §3). The rule applied consistently: **fixed, small, known set of
  money roles on a hot-read row → wide columns; open-ended or naturally list-shaped money data
  → a child table.** `orders` is the former.

**`fx_source = 'UNKNOWN'` is not an error state** — every row migrated from the current
single-currency, no-FX-tracking schema gets `fx_rate = '1'`, `fx_source = 'UNKNOWN'`,
`base_minor = minor_units` (SYP is already the base currency for the single seeded tenant, so
this is honest, not a guess). **Never backfill a guessed rate.** A report reading `UNKNOWN` FX
rows must display that plainly, not silently treat them as `1:1` beyond the historical
fact that they were originally recorded in what was, at the time, the only currency in use.

**Versioned price lists** (§4 of ARCHITECTURE_V2, tied to §3's `menu_item_default`):

```sql
CREATE TABLE price_list (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenant(id),
  label        TEXT NOT NULL,            -- "v7", "Ramadan 2026", etc.
  effective_from TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES staff(id),
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE price_list_item (
  price_list_id TEXT NOT NULL REFERENCES price_list(id),
  item_id       TEXT NOT NULL REFERENCES menu_item_default(id),
  price_minor   INTEGER NOT NULL,
  PRIMARY KEY (price_list_id, item_id)
);
```

`menu_item_default.price_minor` becomes a **materialized read** of "the active price list's
value for this item" — republishing a list is an insert into `price_list`/`price_list_item`,
never an `UPDATE` of the item row directly, so `+8% across the board` is one new price list,
not 200 row edits with no history.

---

## 6. Append-only facts + sync

**Fact tables** (never `UPDATE`d, never `DELETE`d — a correction is a new row):
`orders` (status transitions become `order_status_event` rows, not `orders.status` updates),
`order_items`, `order_modifiers`, `payments`, `voids` (new table — currently voids are
represented as an `order_items.voided` flag flip, which is exactly the anti-pattern this
sprint exists to remove), `debt_entries`, `attendance_events`, `inventory_logs`,
`loyalty_transactions`, `audit_log`.

Fact-row sync shape (per ARCHITECTURE_V2 §5 — nothing to merge, concatenate + order by HLC):
```sql
id TEXT PRIMARY KEY,        -- UUIDv7
tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,   -- every synced row carries both, per ARCHITECTURE_V3 §5
device_id TEXT NOT NULL,
seq INTEGER NOT NULL,       -- per-device monotonic
ts TEXT NOT NULL
```

**Config/mutable tables** (`branch`, `staff`, `menu_item_default`, `menu_item_override`,
`tenant_settings`, `branch_settings`, `category`, `ingredient`, `supplier`, `customer`,
`printer`, `driver`, `delivery_zone`): last-writer-wins per field, sync shape:
```sql
id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT,   -- branch_id NULL for tenant-scoped rows
updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
```
(This is the `updated_at_hlc, device_id, deleted_at, rev` column block referenced by shorthand
throughout §1-§4 above.)

### 6.1 `order_current` — the projection

**LOCAL-ONLY. This table never syncs, in either direction — revised 2026-07-16, blocker #3.**
It is a read cache, rebuilt from the fact stream **independently on every device.** It carries
no `updated_at_hlc`/`device_id`/`rev` sync columns because it is not a row that is ever pushed,
pulled, or reconciled — only facts (`orders`, `order_status_event`, `order_items`, `voids`)
sync. Two devices in the same branch each rebuild their own `order_current` from the same
fact stream and converge because the facts converge, not because this table is shared.

```sql
CREATE TABLE order_current (      -- materialized LOCALLY, rebuilt from the order_* fact stream, never synced
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,   -- local filter/index columns only, not scope-carrying sync metadata
  status TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL,
  discount_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  updated_at TEXT NOT NULL          -- local wall-clock rebuild time, not an HLC, not synced
);
```
Rebuilt by replaying `order_status_event` + `order_items` + `voids` for that `order_id`. The
T1.6 acceptance test (`projection == replay`) asserts this table always equals a fresh replay
from the fact tables — if they ever diverge, the facts win and `order_current` is wrong by
definition, never the reverse. This is the table every current-state UI query reads; nothing
reads the fact tables directly for "what does this order look like right now." Safe to
`TRUNCATE` and fully rebuild at any time with zero data loss, since it holds no information
that doesn't already exist in the fact tables.

---

## 7. Audit log (per ARCHITECTURE_V2 §2, scoped per ARCHITECTURE_V3)

**Revised 2026-07-16, blocker #4: `seq` is an app-maintained per-device counter, not a SQLite
`AUTOINCREMENT`.** There is no single global chain — the chain is **per device**. Two POS
terminals in the same branch each keep their own independent hash chain; there is no
cross-device sequencing at the storage layer, only at reporting time (via `ts`, see below).

```sql
CREATE TABLE audit_log (
  device_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,        -- app-maintained, monotonic PER device_id, starts at 1
  id           TEXT NOT NULL,           -- UUIDv7, globally unique regardless of device/seq
  ts           TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  branch_id    TEXT,                    -- NULL only for genuinely tenant-level actions (e.g. Owner edits tenant_settings)
  actor_id     TEXT NOT NULL REFERENCES staff(id),
  action       TEXT NOT NULL,           -- typed enum in Rust (core::audit::Action), stored as its serde tag — never a free string
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  before_json  TEXT,                    -- canonical JSON (sorted keys, no whitespace)
  after_json   TEXT,
  prev_hash    TEXT NOT NULL,           -- hex SHA256 of THIS DEVICE's previous entry (seq-1); genesis row uses a fixed zero-hash
  hash         TEXT NOT NULL,           -- hex SHA256 of this entry's canonical JSON (including prev_hash)
  PRIMARY KEY (device_id, seq)
);

-- defense in depth: even a compromised query layer cannot rewrite history
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are immutable');
END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log rows cannot be deleted');
END;
```

The command layer (T1.2) reads `MAX(seq) WHERE device_id = this_device` inside the same
transaction as the insert (not a separate read), so `seq` assignment and the mutation it
audits are atomic together — this is why it can't be a SQLite `AUTOINCREMENT` (that would
assign the id outside the app's control and outside the hash computation).

Chain head signature: per-device Ed25519 keypair generated on first run, private key held in
the OS keystore (Windows DPAPI), never in the DB, never plaintext on disk. `verify_audit_chain()`
walks `prev_hash`/`hash` **per `device_id` partition** on boot and before every owner report —
each device's chain is verified independently; a break in one device's chain doesn't implicate
another device's. An owner report merging multiple devices' history for one branch orders
entries by `ts` (wall clock, not `seq`, since `seq` is only comparable within one device) —
this is a display-time concern, not a storage-time one. A break surfaces as the exact Arabic
sentence specified in `ARCHITECTURE_V2.md` §2 ("Records between X and Y were changed outside
the system"), scoped to the branch and device the break was found in.

Every command in T1.2's shape (`authn → resolve Scope → authz → validate → tx → core → audit → commit`)
writes exactly one `audit_log` row per mutation, same transaction, non-negotiable — if the
audit write fails, the whole command fails and rolls back.

---

## 8. Loyalty

```sql
CREATE TABLE customer (
  id          TEXT PRIMARY KEY,     -- UUIDv7. Replaces the current `customers` table.
  tenant_id   TEXT NOT NULL REFERENCES tenant(id),
  name        TEXT NOT NULL,
  phone       TEXT,
  card_uid    TEXT UNIQUE,          -- physical card UID; keyboard-wedge scanner types this directly, no scanner-specific code needed (Phase 2 hardware note)
  points      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
);
```

Tenant-scoped per ARCHITECTURE_V3 §6 — a card works across that tenant's branches (whether
that's actually enabled is a per-tenant config flag deferred to Phase 2, not modeled here).

**Fixes a real bug found in T1.0a**: the current `customers` table joins to `orders` via
`customer_phone` (a mutable string), not a stable id — editing a customer's phone number
silently orphans their order history. `orders` gains a nullable `customer_id REFERENCES
customer(id)`, populated at order-creation time going forward; `customer_phone` stays as a
denormalized snapshot field on the order itself (what the customer's phone *was* at sale
time — consistent with the append-only philosophy: the order shouldn't change if the
customer record does).

Loyalty tier/points-multiplier logic (`TIER_CONFIG`, currently unused per `FEATURE_TRUTH.md`
§9) is not re-specified here — it's application logic over `customer.points`, not a schema
concern, and per §0 this doc doesn't grow features that don't already have a schema.

---

## 9. Per-table migration classification (all 35 existing tables)

Every table gets `tenant_id TEXT NOT NULL` at minimum. Tables tied to one physical location
also get `branch_id TEXT NOT NULL`. Every existing `id` (currently `crypto.randomUUID()`,
i.e. UUIDv4) is **replaced** with a fresh UUIDv7 during EXPAND; the old value is preserved as
`legacy_id TEXT` for exactly one sprint (dropped in T1.8 CONTRACT) so in-flight sync/report
code has a bridge.

**Backfill for all existing rows, no exceptions:** `tenant_id = <the single seeded tenant>`,
`branch_id = <the single seeded branch>` (for branch-scoped tables) — see §10.

| Table | → New name (if renamed) | tenant_id? | branch_id? | Category | Notes |
|---|---|---|---|---|---|
| `users` | `staff` | ✓ | ✓ (NULL if OWNER) | Config | Full redesign, see §1 |
| `categories` | `category` | ✓ | — | Config (tenant default) | |
| `menu_items` | `menu_item_default` + `menu_item_override` | ✓ | override table only | Config | Split table, see §3 |
| `ingredients` | `ingredient` | ✓ | ✓ | Config | Stock is physically per-branch |
| `recipes` | `recipe` | ✓ | — | Config | Tenant-level recipe definition |
| `inventory_logs` | `inventory_log` | ✓ | ✓ | **Fact** | Already append-only in practice; formalize sync shape |
| `tables` | `dining_table` | ✓ | ✓ | Config | Renamed to avoid SQL-reserved-word friction |
| `orders` | `orders` + `order_status_event` | ✓ | ✓ | **Fact** | Status becomes an event stream, see §6 |
| `order_items` | `order_items` | ✓ | ✓ (via order) | **Fact** | Money columns expanded, see §5 |
| `order_modifiers` | `order_modifiers` | ✓ | ✓ (via order) | **Fact** | |
| `payments` | `payments` | ✓ | ✓ | **Fact** | Money columns expanded |
| `shifts` | `shift` | ✓ | ✓ | Config (mutable: open→close) | **Confirmed staying mutable (decision, 2026-07-16) — BUT reopening a closed shift must write an `audit_log` entry.** `reopen_shift` is a new, explicitly audited command (Action::ShiftReopened, before=closed state, after=reopened state); this is exactly the kind of after-the-fact edit an owner needs surfaced, even though the row itself isn't a fact stream. |
| `audit_logs` | `audit_log` | ✓ | nullable | **Fact** | Full rebuild, see §7 |
| `sync_queue` | *(removed)* | — | — | — | Replaced by the Rust outbox pattern (ARCHITECTURE_V2 §5); this table was already dead (T1.0a found no consistent writer) |
| `printers` | `printer` | ✓ | ✓ | Config | Physical hardware, branch-native |
| `combo_meals` / `combo_items` | `combo_meal` / `combo_item` | ✓ | — | Config (tenant default) | Same layer as menu |
| `happy_hour_rules` | `happy_hour_rule` | ✓ | — | Config (tenant default) | |
| `chain_config` | `tenant_settings` + `branch_settings` | ✓ | split | Config | See §4 |
| `delayed_orders` | `delayed_order` | ✓ | ✓ | Config (short-lived) | |
| `branches` | `branch` | ✓ | *(is the branch)* | Config | Full redesign, see §1 |
| `customers` | `customer` | ✓ | — | Config | See §8; `card_uid` added |
| `suppliers` | `supplier` | ✓ | ✓ | Config | |
| `purchase_orders` / `purchase_order_items` | same | ✓ | ✓ | Config→Fact once received | PO header mutable pre-receipt; receipt event is a fact — deferred detail, not blocking T1.0b |
| `loyalty_cards` | *(merged into `customer`)* | ✓ | — | Config | `card_uid`/`points` absorbed into §8's `customer` table — one fewer join |
| `loyalty_transactions` | `loyalty_transaction` | ✓ | ✓ | **Fact** | |
| `invoices` | `invoice` | ✓ | ✓ | Config (mutable: pending→paid) | |
| `operational_costs` | `operational_cost` | ✓ | ✓ | **Fact** (append-only expense record) | |
| `attendance` | `attendance_event` | ✓ | ✓ | **Fact** | Clock-in/out become events, not one row mutated in place |
| `terminals` | `terminal` | ✓ | ✓ | Config | **Aligned with `zaeem-control`'s Prisma `Terminal` model now (decision, 2026-07-16)** — see shape below |
| `notifications` | `notification` | ✓ | ✓ | **Fact** | Phase 2 feature per §0, but the table already exists — scope it now, don't build new notification logic |
| `drivers` | `driver` | ✓ | ✓ | Config | |
| `delivery_zones` | `delivery_zone` | ✓ | ✓ | Config | |
| `delivery_logs` | `delivery_log` | ✓ | ✓ | **Fact** | |
| *(new)* `voids` | — | ✓ | ✓ | **Fact** | Replaces the `order_items.voided` flag flip — see §6 |
| *(new)* `debt_entries` money columns | — | ✓ | ✓ | **Fact** | Already append-only per `FEATURE_TRUTH.md` §14; gets the Money column expansion from §5 |
| *(new)* `tenant`, `staff`, `menu_item_default/override`, `tenant_settings`, `branch_settings`, `price_list(_item)`, `order_current`, `order_status_event` | — | — | — | — | Covered in §1-§6 above |

`debtors`/`debt_entries` (from `FEATURE_TRUTH.md` §14, not in the original 35-table grep
because they weren't in the schema.sql excerpt reviewed) follow the same treatment as
`customers`/`payments` respectively — Config + Fact — and get `tenant_id`/`branch_id` plus
the §5 Money expansion on `debt_entries.amount`.

### 9.1 `terminal` — aligned with `zaeem-control` (item #7, decided 2026-07-16)

`zaeem-control`'s existing Postgres `Terminal` model is `{ id, branchId, name, version, lastSync }`.
The local SQLite shape mirrors it field-for-field (plus the multi-tenant/sync columns every
Config table gets), so the eventual sync bridge between the local `terminal` row and the cloud
`Terminal` row is a straight field copy, not a translation layer:

```sql
CREATE TABLE terminal (
  id            TEXT PRIMARY KEY,     -- UUIDv7; same id space the cloud Terminal.id will adopt
  tenant_id     TEXT NOT NULL REFERENCES tenant(id),
  branch_id     TEXT NOT NULL REFERENCES branch(id),   -- matches Terminal.branchId
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,        -- matches Terminal.version (app version string, for fleet visibility)
  last_sync     TEXT,                 -- matches Terminal.lastSync
  updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
);
```

---

## 10. Data migration plan (the EXPAND step, detailed in T1.1)

**Revised 2026-07-16, item #5: the UUIDv4→UUIDv7 FK remap is its own isolated migration, with
its own snapshot and its own test, run separately from (and after) the column-adding EXPAND
steps below.** Rationale: column additions and backfills are additive and low-risk (a failure
leaves old data intact, unread by anything new yet); an FK remap across every reference in 35
tables is the single highest-risk step in this whole plan, and bundling it with anything else
makes a partial failure harder to isolate and roll back.

### 10.1 Migration A — EXPAND (columns, tenant/branch backfill, sync/money columns)

For every table above:
1. `ALTER TABLE ... ADD COLUMN tenant_id TEXT`, `branch_id TEXT` (nullable during EXPAND).
2. Seed exactly one row in `tenant` (`name = <current chain_config.chain_name>`,
   `base_currency = <current chain_config.currency>`, `is_demo = 0`) and one row in `branch`
   (`name = <current branches row if one exists, else 'الفرع الرئيسي'>`, `currency = <current
   chain_config.currency>` — identical to the tenant's base currency at seed time, so no
   cross-currency override is needed for the migrated install itself) representing the
   existing single-restaurant install.
3. `UPDATE {table} SET tenant_id = '<seeded tenant id>', branch_id = '<seeded branch id>'`
   (branch_id omitted for tenant-scoped tables).
4. Money columns: `{col}_minor = {col}_cents`, `{col}_currency = branch.currency`,
   **`{col}_scale = MoneyPolicy::scale_for({col}_currency)` — read from the policy, never a
   literal (blocker #1, 2026-07-16; this replaces an earlier draft that incorrectly hardcoded
   `scale = 0`)**, `{col}_base_minor = {col}_cents` (identity conversion: the seeded branch's
   currency equals the seeded tenant's base currency, so no rate is invented), `{col}_fx_rate =
   '1'`, `{col}_fx_source = 'UNKNOWN'`, `{col}_denom_epoch = 2`.
5. Sync columns: `updated_at_hlc = last_modified` (reuse existing timestamp as the initial
   HLC value — not a real hybrid-logical-clock yet, just a valid starting point), `device_id
   = <this machine's newly-generated device UUID>`, `rev = sync_version` (reuse existing
   counter), `deleted_at = NULL`.
6. `NOT NULL` constraints on `tenant_id`/`branch_id` are added only in a **second** migration
   step after backfill completes and is verified — never in the same statement as the column
   add, so a failure mid-backfill never leaves the DB in an unqueryable state.

**Acceptance test for Migration A:** load a 6-month synthetic order fixture, run EXPAND, sum
`total_minor` (converted back to legacy cents via `scale`) grouped by order — must be
**bit-identical, order by order**, to the pre-migration `total_cents` sum. Not "close." Identical.

### 10.2 Migration B — UUIDv4 → UUIDv7 FK remap (isolated, runs after A is verified)

1. Snapshot the database (file-level copy) immediately before this migration runs — this
   snapshot is the rollback target if anything below fails, independent of Migration A's state.
2. `ALTER TABLE ... ADD COLUMN legacy_id TEXT`; `UPDATE {table} SET legacy_id = id` for every
   table, in one pass, before any id is rewritten.
3. Generate a fresh UUIDv7 per row across all 35+ tables (one pass, all new ids allocated and
   held in a mapping table `id_remap(table_name, legacy_id, new_id)` before any row is touched).
4. Apply the remap: update each table's own `id` from the mapping, then update every FK column
   that references it, driven entirely by the `id_remap` table — not by re-deriving new ids
   inline per foreign key, so every reference to the same logical row gets the same new id.
5. `legacy_id` is retained for exactly one sprint (dropped in T1.8 CONTRACT) so in-flight
   sync/report code has a bridge.

**Acceptance test for Migration B, standalone (per item #5):** after the remap, for every FK
column in the schema, assert `SELECT COUNT(*) FROM {child} WHERE {fk_col} NOT IN (SELECT id
FROM {parent}) = 0` — zero orphaned references, checked exhaustively, table by table. This test
is separate from and in addition to Migration A's revenue-bit-identical test; a schema with
correct money totals but one dangling foreign key still fails this gate.

---

## 11. Decisions log (all prior open questions resolved 2026-07-16)

1. **`ACCOUNTANT` role** — dropped, folded into `MANAGER` rank. Applied in §1.
2. **`shifts` staying mutable** — confirmed, with a new requirement: reopening a closed shift
   writes an `audit_log` entry via a new `reopen_shift` command. Applied in §9.
3. **`purchase_orders` fact-transition point** — header is Config until received; the receive
   action writes immutable `inventory_log` + `operational_cost` facts. Not blocking T1.0b;
   revisit before T1.6 reaches inventory commands. Recorded in §9's row, unchanged from draft 1.
4. **`terminals` alignment with `zaeem-control`** — done now, field-for-field. Applied in §9.1.
5. **`scale` hardcoding** — fixed. `scale` is derived from `currency` via `MoneyPolicy::scale_for`,
   never a literal, in both the migration backfill and all future writes. Applied in §5 and §10.1.

Additionally resolved in this revision (blockers #2, #3, #4, and item #6, none of which were
open questions in draft 1 — they were correctness issues in the draft itself, now fixed):
menu pricing has no live FX conversion (§3), `order_current` is local-only and never syncs
(§6.1), `audit_log`'s hash chain is per-device with an app-maintained `seq` (§7), and the wide-
vs-tall money-column choice for `orders` is justified explicitly (§5).

**No open questions remain in this document as of 2026-07-16. Stop for review anyway — this is
the gate that doesn't get skipped even when the draft author believes it's complete.**
