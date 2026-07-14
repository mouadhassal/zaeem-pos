# CLAUDE.md — Agent Operating Contract

You are working on **Zaeem POS**, a restaurant operating system.
Read this file completely before every task. These rules override any instinct you have.

---

## 0. Prime directives

1. **Never claim something works that you have not run.** No aspirational documentation. If a
   feature is a stub, the docs say `STUB`. Fabricated claims in a README are treated as a P0 bug.
2. **Do not add features.** The feature surface is frozen. Your job for the next 8 weeks is depth,
   correctness, and safety on what exists. If a task seems to require a new feature, stop and ask.
3. **Money is sacred.** Any code path that touches an amount, an order, a payment, or a shift
   reconciliation gets a test. No exceptions, no "it's obvious."
4. **The threat model is the employee.** Not a hacker. A cashier with an hour alone and a mouse.
   Every design decision is judged against: *can a cashier steal, and can the owner detect it?*
5. **The restaurant has no internet and no power.** Every feature must work with the network cable
   pulled out and survive `kill -9` at any instruction.

---

## 1. Hard architectural rules

### R1 — The frontend never touches the database.
There is exactly one path to SQLite: **Rust command handlers**.

```
React ──invoke()──▶ Rust command layer ──▶ repository ──▶ SQLite
```

- No `getDb()` in the frontend. No Kysely in the frontend. No SQL strings in `.ts` files.
- If you find yourself importing `@tauri-apps/plugin-sql` in `src/`, you have made a mistake.
- Every command validates its caller's role in Rust before doing anything.

### R2 — No country logic in core.
`grep -r "Syria\|SY\|Saudi\|ZATCA\|SYP" src/ src-tauri/src/core/` must return **zero** results.
All country behaviour lives behind traits in `src-tauri/src/market/`. See `ARCHITECTURE_V2.md`.

If you are tempted to write `if (country === "SY")`, you are writing a bug. Add a method to the
relevant trait instead.

### R3 — Money is never a float, never a bare integer.
Use the `Money` type. It carries `{ minor_units: i64, currency: Currency, scale: u8 }`.
A raw `i64` labelled `_cents` is banned in any new code.

### R4 — Orders and payments are immutable append-only facts.
You do not `UPDATE` an order total. You append a correcting entry. This makes sync conflict-free
for money and makes the audit log meaningful. Voids are entries, not deletions.

### R5 — Every mutation writes an audit entry, in the same transaction.
If the audit write fails, the mutation fails. The audit log is hash-chained (`prev_hash`).

---

## 2. Definition of Done

A task is **not done** until all of these are true. Do not report completion otherwise.

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm lint` — clean
- [ ] `cargo clippy -- -D warnings` — clean
- [ ] `cargo test` — green
- [ ] `pnpm test` — green
- [ ] New/changed money paths have tests
- [ ] `pnpm test:chaos` passes (kill -9 during writes → no corruption, no lost orders)
- [ ] No new `TODO` without a linked issue number
- [ ] Docs updated to match reality, including the parts that got worse

---

## 3. Conventions

- **Rust**: `thiserror` for errors, `tracing` for logs, `rusqlite` with explicit transactions.
  Commands are thin; logic lives in `core/`. Commands never contain SQL.
- **TypeScript**: strict mode. `unknown` over `any`. Zod at every Rust↔TS boundary — the Zod schema
  and the serde struct are the same contract and must be kept in sync (there is a codegen check).
- **IDs**: UUIDv7 everywhere. Never autoincrement. Never sequential exposure.
- **Time**: store UTC epoch millis. Render in branch timezone. Never store local time.
- **Naming**: English in code, Arabic in the UI. Never Arabic identifiers in source.

---

## 4. Working style

- Small commits, one concern each. Conventional commits.
- Before a big refactor, write the plan to `docs/plans/<name>.md` and stop for review.
- When you break something you didn't intend to touch, say so loudly in your summary.
- **If a task's acceptance criteria cannot be met, stop and report why. Do not fake it and do not
  narrow the criteria to something you can pass.**

---

## 5. Things that are currently wrong and must not be re-introduced

These existed in v0.1 and are being removed. If you see them come back, that's a regression:

- Seed users with known passwords (`admin123`) shipped in a release build
- `lib/license.ts` returning `active` unconditionally
- `CSP: null` in `tauri.conf.json`
- Password hash comparison in the renderer
- `debug/page.tsx` reachable in a release build
- Ad-hoc `ALTER TABLE` migrations with no version table
- Permission checks that exist only in React (`canAccessX()` with no Rust counterpart)
