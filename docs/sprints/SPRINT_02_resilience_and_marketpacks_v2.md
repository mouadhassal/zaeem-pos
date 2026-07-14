# SPRINT 02 (v2) — Resilience & Market Packs

**Duration:** 5–7 days (down from 7–9; the money model moved into S1).
**Supersedes:** `SPRINT_02_resilience_and_money.md` v1. Delete v1.
**Depends on:** S1 green.

**What changed:** T0.1 found that S1 and S2 collided on the same 30+ `_cents` columns. The `Money`
type, price lists, dual currency and the schema migration are now **S1 T1.0b / T1.1 / T1.6 / T1.8**.
This sprint keeps only what's left: surviving the power grid, and making every other country a
plugin.

---

## Part A — Survive the power cut

Syrian restaurants lose power without warning, daily. The chaos harness from S0 currently fails.
Make it pass.

### T2.1 — Durability
- `PRAGMA synchronous = FULL` for any transaction touching `payments`, `orders`, `shifts`,
  `debt_entries`, `audit_logs`. `NORMAL` stays for menu and settings.
- **Split the connection pool by criticality.** A menu save must not pay the fsync cost; a payment
  must. One pool, one policy, is the wrong answer here.
- Success is returned to the renderer **only after commit**. The UI's "Paid" state is derived from
  Rust's answer, never assumed.

### T2.2 — Boot recovery
In order, every launch:
1. `PRAGMA integrity_check` → if not `ok`, enter recovery mode.
2. `verify_audit_chain()` → if broken, flag and surface. **Never silently continue.**
3. Recovery: attempt `.recover`; else restore the newest snapshot passing both checks; then tell the
   owner **exactly which window of data was lost.**

A POS that silently loses six orders is worse than one that names the six. Honesty is the feature.

### T2.3 — Snapshots
- Rolling hourly during service (retained 72h) + one nightly (retained 30 days).
- Use the **SQLite backup API**, not a file copy — with WAL on, a file copy is not a valid backup.
- Write a second copy to a different physical device if one exists (USB stick, second drive).
  One dying SSD should not end a restaurant.
- **Verify every snapshot immediately after writing it** (open, `integrity_check`, chain verify).
  An unverified backup is not a backup, it's a feeling.

### T2.4 — Unclean-shutdown reconciliation
On boot after a hard kill, find any order that was mid-payment and put it to the cashier:

> **الطلب ‎#412 انقطع أثناء الدفع. هل تم الدفع؟**
> نعم، تم الدفع · لا، أعد فتح الطلب

Show the printed receipt (if one exists) as evidence. **Do not guess.** Guessing wrong in either
direction is theft — of the customer, or of the owner.

**Acceptance:** `pnpm test:chaos`, N=200 `kill -9` cycles → zero corruption, zero lost confirmed
payments, zero phantom payments, audit chain verifies every time. Runs nightly in CI.

---

## Part B — Market Packs

### T2.5 — Traits and registry
Implement per `ARCHITECTURE_V2.md` §3: `MoneyPolicy`, `EntitlementAdapter`, `FiscalAdapter`,
`PaymentAdapter`, `ChannelAdapter`, `LocalePack`, and `MarketPack` binding them.

Ship exactly two packs:

- **`SyriaPack`** — real. SYP/USD dual pricing, `denom_epoch` aware, `OfflineSignedLicense`,
  `NoFiscal`, `CashOnly`, `ar-SY` RTL.
- **`GenericPack`** — a deliberately boring reference: single currency, `CloudSubscription` stub,
  `NoFiscal`, `CashOnly`, `en` LTR.

`GenericPack` exists for one reason: **to prove the abstraction holds.** If making it work requires
touching `core/`, the abstraction is wrong — fix the abstraction, never `core/`.

This is the task that makes the pivot real. After it, Iraq is three days, Egypt is an `EtaAdapter`,
KSA is a `ZatcaPhase2Adapter`, and none of them touch the domain.

### T2.6 — The guardrail

Flip to **blocking** in CI:

```bash
grep -rniE "syria|syrian|\bSYP\b|zatca|fatoora|\bSAR\b|talabat|jahez|hungerstation" \
  src-tauri/src/core/ src-tauri/src/repo/ src/ && {
    echo "FAIL: country-specific knowledge leaked into core."; exit 1; }
exit 0
```

This one script is the difference between one codebase and five. A failure here is a
build-breaking bug. **Never add to the allowlist to make it pass.**

---

## Definition of done for S2

- [ ] Chaos test N=200 → zero corruption, zero lost payments, zero phantom payments, chain verifies
- [ ] Snapshot restore test: corrupt the live DB, restart, restore, verify, and the reported "lost
      window" is exactly correct
- [ ] Unclean-shutdown reconciliation prompt appears and resolves correctly in both directions
- [ ] `GenericPack` passes the entire test suite with **zero changes to `core/`**
- [ ] `check-no-country-in-core.sh` is blocking and green
