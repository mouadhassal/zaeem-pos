# SPRINT 01 (v2) — The Trust Boundary + The Great Migration

**Duration:** 13–16 days. Revised upward after T0.1: 37 `getDb()` call sites, ~130–150 commands,
audit chain is a from-scratch build.
**Supersedes:** `SPRINT_01_trust_boundary.md` v1. Delete v1.
**Depends on:** S0 green, git initialized and tagged `v0.1-pre-agent`.

---

## Why this sprint changed

T0.1 found that S1 (append-only orders) and S2 (the `Money` type) both rewrite the same 30+
`_cents` columns. Doing them as two sprints means **two destructive migrations on the same tables.**
That is unacceptable risk on data we cannot reconstruct.

So the money model moves out of S2 and into S1. There is now exactly **one** schema migration in the
life of this product, and it lands everything at once: money, append-only, sync, and audit.

Strategy is **expand → migrate → contract**:

```
T1.0b  design the ONE target schema           (doc only, review gate)
T1.1   EXPAND   add all new columns, keep old ones, dual-write
T1.2–7 MIGRATE  build the Rust layer against the NEW columns
T1.8   CONTRACT drop the legacy _cents columns once nothing reads them
```

At no point is the database in a state that cannot be rolled back to.

---

## T1.0a — Command inventory

Enumerate every DB read and write the frontend performs across all 37 `getDb()` call sites.

```
| Call site (file:line) | Command name | Args | Returns | Permission required | Mutating? |
```

Modules: `auth`, `orders`, `menu`, `inventory`, `staff`, `shifts`, `customers`, `debt`, `loyalty`,
`delivery`, `reports`, `settings`, `printing`.

Expect **130–150**. Fewer than 110 means you missed things — go back.

**Stop for review. Write no code.**

---

## T1.0b — The unified target schema  ← NEW, and the most important task in the sprint

One document: `docs/SCHEMA_V2.md`. For **every table**, specify the target shape carrying *all four*
concerns simultaneously:

**Money** (per `ARCHITECTURE_V2.md` §4)
- `amount_minor i64`, `currency`, `scale`
- on transactional tables also: `base_amount_minor`, `fx_rate`, `fx_source`, `denom_epoch`

**Append-only** (per `AGENTS.md` R4)
- Orders, order_items, payments, voids, debt_entries are **facts**. Never `UPDATE`d.
- A void is an appended entry, not a deletion. A price correction is an appended entry.
- Current state is a *projection* over the fact stream. Decide now: materialized view, or computed?
  (Recommendation: a materialized `order_current` table, rebuilt from facts, with a test that
  asserts projection == replay. If they ever diverge, the facts win.)

**Sync** (per `ARCHITECTURE_V2.md` §5)
- Every mutable row: `id UUIDv7`, `updated_at_hlc`, `device_id`, `deleted_at`, `rev`
- Every fact row: `id UUIDv7`, `device_id`, `seq`, `ts` — and nothing else, because facts never change

**Audit**
- `audit_logs` gets `seq`, `prev_hash`, `hash`, `device_id` and SQLite triggers blocking
  `UPDATE`/`DELETE`

Also specify **the migration of existing data** for each table, and what happens to a row where the
FX rate is unknown. (Answer: `fx_source = UNKNOWN`. **Never invent a rate.** A wrong number in a
financial history is worse than a missing one.)

**Stop for review. Write no code.** This document is the thing we cannot get wrong; everything else
in the sprint is recoverable.

---

## T1.1 — EXPAND migration

- One numbered migration adding every new column from `SCHEMA_V2.md`. Legacy `_cents` columns stay.
- Backfill: `amount_minor = old_cents`, `currency = SYP`, `denom_epoch = 2`, `fx_source = UNKNOWN`.
- Generate UUIDv7 for every existing row; keep old integer ids as `legacy_id` for one sprint.
- **Acceptance:** fixture DB with 6 months of synthetic orders → migrate → **total revenue is
  bit-identical, order by order.** Not "close." Identical. This test lives forever.

---

## T1.2 — Command scaffold

`src-tauri/src/`:
```
commands/   thin. authn + authz + validate + tx + call core + audit. NO SQL.
core/       pure domain. NO SQL, NO tauri, NO country names. Unit-testable.
repo/       the ONLY place rusqlite appears.
market/     MarketPack traits (stub; S2 fills them)
audit/      hash chain + Ed25519 signing
security/   session, RBAC, license, OS keystore
```

Every command has exactly this shape. A lint enforces it:

```rust
#[tauri::command]
pub async fn void_order_item(
    state: State<'_, App>,
    session: SessionToken,
    item_id: Uuid,
    reason: String,
) -> Result<(), AppError> {
    let actor = state.security.authenticate(&session)?;           // who
    state.security.authorize(&actor, Perm::VoidItem)?;            // may they
    let input = VoidItemInput::validate(item_id, &reason)?;       // is it sane
    let mut tx = state.repo.begin()?;                             // ONE transaction
    let event = core::orders::void_item(&mut tx, &actor, input)?; // domain
    state.audit.append(&mut tx, &actor, &event)?;                 // audit, same tx
    tx.commit()?;
    Ok(())
}
```

If the audit append fails, the whole thing rolls back. Non-negotiable.

**Fix while you are here** (found in T0.1):
- `diagnose_db` opens a second `Connection` — it must use the shared pool. It is currently racing
  every write in the app.
- `update_order_status` accepts arbitrary strings. Typed enum, validated in Rust.

---

## T1.3 — Real RBAC

- `Permission` enum, not role strings: `TakeOrder`, `VoidItem`, `ApplyDiscount(max_bps)`,
  `OpenShift`, `ForceCloseShift`, `EditMenu`, `ViewCosts`, `ViewFinance`, `ManageStaff`, ...
- `Role → Set<Permission>` lives in Rust and only in Rust. All 17 existing commands currently accept
  any caller — every one of them gets a check.
- Frontend may call `get_my_permissions()` to *hide* buttons. That is a UX affordance, never a
  control. Every command re-checks.
- Manager PIN escalation → a Rust-issued **60-second, single-use, single-permission elevation
  token**. Not a boolean in React state.
- Discount caps enforced in `core::pricing`, not in a React `getMaxDiscountPercent()`.

**Test:** every command × every role, table-driven. ~150 × 6.

---

## T1.4 — Session & auth

- bcrypt (cost 12) verification **only** in Rust. `lib/auth.ts` becomes an `invoke` wrapper or dies.
- Session token: 256-bit random, stored hashed, `expires_at`, bound to `device_id`.
- Idle timeout 15 min → **PIN re-entry, not logout.** A cashier logs in twenty times a shift.
- **`change_password` must take the user from the session, never from the caller's arguments.**
  Today anyone who learns a colleague's old password can take their account, with no rate limit.
  This is an account-takeover bug. Add exponential backoff, lock at 10 failures.

---

## T1.5 — Hash-chained, signed audit log

`audit_logs` is currently a **dead table** — nothing writes to it. Build it from scratch.

```rust
struct AuditEntry {
    id: Uuid, seq: u64, ts: i64, device_id: Uuid, actor_id: Uuid,
    action: Action,          // typed enum, never a free string
    entity: EntityRef,
    before: Option<Json>, after: Option<Json>,
    prev_hash: [u8; 32],
    hash: [u8; 32],          // SHA256(canonical_json(all of the above))
}
```

- Canonical JSON (sorted keys, no whitespace) so the hash is reproducible across machines.
- Chain head signed with a per-device **Ed25519** key, generated on first run, held in the OS
  keystore (Windows DPAPI). Never in the DB. Never plaintext on disk.
- SQLite triggers block `UPDATE`/`DELETE` on `audit_logs` as defence in depth.
- `verify_audit_chain()` on boot and on every owner report. A break surfaces to the owner as:
  > **"Records between 14 Mar 21:04 and 14 Mar 23:11 were changed outside the system."**

  That sentence is the product. It is what the owner is actually paying for.

---

## T1.6 — Money & append-only domain

- `Money` / `MoneySnapshot` types. Ban raw `_cents: i64` in new code via clippy + CI grep.
- Orders/payments/voids become append-only facts. `order_current` projection + a test asserting
  **projection == replay of the fact stream.**
- **Versioned price lists**: `price_list`, `price_list_item`, `effective_from`. The active price is
  *stamped onto the order item* at order time, so a re-price never rewrites history.
- Owner screen: duplicate list → adjust (absolute / **+N% across the board** / per-category) →
  preview diff → publish. In a triple-digit-inflation economy this one screen is worth more to a
  Syrian owner than the entire loyalty module.
- FX rate is set once at shift open, and **every change is written to the audit chain.** "Who moved
  the dollar rate at 23:40" is exactly the theft the owner bought this to catch.

---

## T1.7 — Frontend migration (37 call sites)

- Every store becomes a thin `invoke` client. `getDb()` deleted. Kysely and
  `@tauri-apps/plugin-sql` removed from `package.json`.
- `src/ipc/` — one Zod schema per command, mirroring the serde struct. **Codegen check fails CI if
  they drift.**
- Optimistic UI allowed **only** off the money path. Adding to a cart: optimistic. Taking a payment:
  waits for Rust, real spinner, real error.
- **The payment flow becomes ONE Rust transaction.** Today `pos/page.tsx:190–306` runs order create,
  payment insert, table free, loyalty points and print as sequential awaits — a crash mid-sequence
  leaves the table `OCCUPIED` and the order `PAID`. That entire function collapses into
  `commands::orders::take_payment`. The loyalty bare-`try/catch` at `:299` dies with it.

---

## T1.8 — CONTRACT migration

Drop legacy `_cents` and `legacy_id` columns once nothing references them. Full fixture test again:
revenue bit-identical.

---

## Definition of done for S1

- [ ] `check-no-sql-in-frontend.sh` passes and is **blocking** in CI
- [ ] `kysely` and `@tauri-apps/plugin-sql` gone from `package.json`
- [ ] RBAC matrix green: every command × every role
- [ ] Audit chain verifies; "corrupt a row → detected" test green; DB triggers reject direct writes
- [ ] Money migration: 6-month fixture, revenue **bit-identical** through EXPAND and CONTRACT
- [ ] Projection == replay test green
- [ ] License: valid / expired / grace / wrong-machine / forged-signature all behave correctly
- [ ] **Payment atomicity test:** `kill -9` between every pair of steps in `take_payment`, 100×.
      Never a `PAID` order on an `OCCUPIED` table. Never a payment without an order.
- [ ] **Red-team test — 20 scripted privilege escalations, all must fail:** zero out a total, delete
      an audit row, self-promote to OWNER, exceed the discount cap, void another cashier's item,
      forge a session, change a colleague's password, set an FX rate without permission.
      This test lives in the repo forever.
