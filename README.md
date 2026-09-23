# WENZDES POS (نقطة البيع)

Offline-first point of sale for restaurants/cafés and grocery/retail shops, sold in Damascus.

**Version** 0.4.1 (`package.json` = `src-tauri/Cargo.toml` = `src-tauri/tauri.conf.json`) · **Identifier** `com.wenzdes.pos` · **© 2026 Wenzdes**

Plans: POS Lite 975 ل.س/month, POS Pro 1,950 ل.س/month per register (`pos_lite` hides the CRM/ERP pages; enforced in Rust).

Read `AGENTS.md` before changing anything.

---

## 1. What it is

A Tauri v2 desktop app (Windows primary, macOS builds too). Everything a register needs runs locally against SQLite; the network is optional.

```
React (src/) ──invoke()──▶ Rust commands (src-tauri/src/commands/*) ──▶ repo.rs ──▶ SQLite (WAL)
```

- The frontend never touches the database. Every command authenticates the session and checks the caller's role in Rust (`security.rs`).
- Roles by rank: `PLATFORM` > `OWNER` > `MANAGER` > `CASHIER` / `KITCHEN` / `SERVER`. Higher ranks get every lower permission.
- Mutations write a hash-chained audit entry in the same transaction (`audit.rs`).

## 2. Features (as implemented)

| Area | Notes |
|---|---|
| POS | Tables (optional), order types DINE_IN / TAKEAWAY / DEBT, modifiers, combos, happy hour, split/merge/transfer, hold/resume, send-to-kitchen-then-pay tabs, cash/card/wallet (card/wallet need a terminal reference), loyalty earn/redeem, receipt + kitchen printing (ESC/POS USB/network) with on-screen fallback |
| Shifts | A sale can only be created or paid with the cashier's own open shift. Close with cash count; manager PIN above the configured difference threshold. Manager/Owner can force-close a stuck shift |
| Manager PIN | Void and shift-difference thresholds are per-tenant settings, defaults 500 / 1,000 in the tenant currency's major unit (new SYP) |
| Business presets | "مطعم / مقهى" (tables + kitchen/KDS) or "بقالة / متجر" (no tables, no KDS) at setup and in Settings, stored as `has_tables` / `has_kitchen` |
| Menu / products | Categories, items, barcodes, photos, recipes (BOM) linking items to ingredients |
| Inventory | Ingredients, stock adjust/counts, suppliers + supplier ledger, purchase orders with receive; low-stock POs prefill their lines; "إعادة الطلب" opens the marketplace reorder page; marketplace deliveries tab (cloud-activated terminals only) |
| Customers / debt | Customer CRM, loyalty tiers/rewards, debtor ledger with credit limits |
| Back office | Dashboard, reports, finance (costs, invoices, P&L), staff + attendance + roster, branches, anomaly/forecast views, AI assistant (LLM call over a bounded data snapshot) |
| KDS | Kitchen display (hidden when the business has no kitchen) |
| Delivery | `DELIVERY` order type and the driver/zone fleet were removed (migration `0027_fleet_removal.sql`) |

## 3. Money

Amounts are integers in the currency's minor unit (`*_cents` columns). `money.rs::scale_for` / `src/lib/money.ts::scaleFor` define the scale: SYP and IQD are scale 0 (a stored `500` is 500 ل.س), most others 2, KWD/BHD/OMR/JOD 3. Prices were divided by 100 for the 2026 SYP redenomination (migration v25).

## 4. Cloud and network (all optional)

- **Licensing**: signed offline license file (Ed25519, verified in Rust) plus an optional cloud check with a per-device token (`license/cloud.rs`). Offline-CLI licenses have no device token.
- **Sync**: facts go into `sync_outbox` in the same transaction and a 30 s background worker pushes them to the `sync-pos` Edge Function. Selling never waits on the network.
- **Marketplace goods received**: pulls `pos_list_pending_receipts`, applies stock locally, and queues `pos_mark_order_received` (idempotent, retried) — `goods_receipt.rs`.
- **Updates**: Tauri updater with signed artifacts.
- **LAN**: one terminal can be the branch Hub; satellites and KDS screens relay order commands to it.
- **Backups**: manual and scheduled SQLite backups with an optional secondary destination.

## 5. Development

Prerequisites: Node 20, pnpm, Rust stable. This app is also a package in the monorepo's pnpm workspace.

```bash
pnpm install
pnpm dev                 # Vite only (UI work without Tauri)
pnpm tauri dev           # full desktop app
pnpm typecheck
pnpm test:unit           # vitest
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm build               # tsc + vite build
```

Build-time env: `VITE_MARKETPLACE_URL` (default `https://market.wenzdes.com`).

## 6. Releases

- `.github/workflows/release-windows.yml` — on `v*` tags or manual dispatch: builds NSIS + MSI, signs updater artifacts, uploads installers and `.sig` files.
- `.github/workflows/release-macos.yml` — test DMG builds (unsigned updater artifacts).

Required GitHub secrets for Windows releases:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key (must match `plugins.updater.pubkey` in `tauri.conf.json`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key (empty if none) |

Optional repository variable: `VITE_MARKETPLACE_URL`. The installers are not Authenticode code-signed yet, so Windows SmartScreen will warn on first install.
