# FEATURE_TRUTH.md — Honest Feature Inventory

**Generated:** 2026-07-14
**Method:** Code-only audit. Every claim is backed by a file:line reference. README claims are compared against what actually executes at runtime.

---

## Classification Key

| Status | Meaning |
|--------|---------|
| `WORKS` | Implemented, exercised, no known gap at the code level |
| `PARTIAL` | Happy path only, or logic exists but is disconnected from the runtime |
| `STUB` | UI exists, no logic behind it |
| `FICTION` | Claimed in some document, does not exist in code |

---

## Architecture Verdict

**Current state:** The frontend owns the database. All business logic lives in TypeScript calling SQLite via Kysely. Rust has 17 commands but they cover only auth, debt, kitchen display, settings, and diagnostics — none of the core POS flow (orders, payments, inventory, menu) goes through Rust.

**CLAUDE.md R1 violation:** `getDb()` is called at 37 sites across `src/`. All order, payment, inventory, and menu operations bypass Rust entirely.

**CLAUDE.md R5 violation:** The `audit_logs` table exists in the schema but no Rust command and no TypeScript service writes to it consistently. `db/audit.ts` has a `logAudit()` function but the first audit pass found zero callers.

---

## Feature-by-Feature Audit

### 1. Point of Sale — Core Flow

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Table management (FREE/OCCUPIED/MERGED) | `WORKS` | `pos/page.tsx:125-175` — tables fetched via `getDb()` → Kysely, status enum enforced by DB CHECK | All via frontend Kysely, not Rust |
| Item entry into cart | `WORKS` | `cartStore.ts` — addItem/removeItem/updateQuantity, pure Zustand in-memory | — |
| Menu grid with categories | `WORKS` | `pos/page.tsx:155`, `MenuGrid.tsx` — category dock + filtered menu items | — |
| Order creation | `WORKS` | `orderService.ts:41-110` — inserts `orders` + `order_items` + `order_modifiers`, marks table OCCUPIED | All via `getDb()`, not Rust |
| Order finalization / payment | `WORKS` | `pos/page.tsx:190-270` — updates order to PAID, inserts `payments`, frees table, attempts print | Kysely frontend, no Rust |
| Payment methods (CASH/CARD/WALLET/CREDIT) | `PARTIAL` | `PaymentModal.tsx` — CASH works with change calc, CARD/WALLET are mock UI that just marks paid, CREDIT creates debt entry | Card/wallet: no real payment gateway |
| Split bill | `WORKS` | `orderService.ts:375-423` — transactional: new orders per split, items moved, original linked via `parent_order_id` | Frontend Kysely |
| Merge tables | `WORKS` | `orderService.ts:425-478` — tables marked MERGED, items moved to target, source cancelled + `unmergeTables()` at 480 | Frontend Kysely |
| Transfer order | `WORKS` | `orderService.ts:510-537` — order `table_id` updated, source table freed, target occupied | Frontend Kysely |
| Void items with reason | `WORKS` | `cartStore.ts` — `voidItem()` sets `voided=true`, `void_reason` | Frontend Kysely |
| Manager PIN for discounts/voids | `WORKS` | `ManagerPinModal.tsx` — PIN verification via authStore (compare against user's password_hash) | PIN verified in frontend, no Rust elevation token |
| Hold/retrieve draft orders | `WORKS` | `orderService.ts:129-145` save as DRAFT, `orderService.ts:147-174` retrieve items back | Frontend Kysely |
| Delayed/scheduled orders | `WORKS` | `orderService.ts:539-573` + `delayed_orders` table, 30s poll for activation | Frontend Kysely |
| Driver selection for delivery | `WORKS` | `DriverSelectModal.tsx` + `orderTypeStore.setDriverId()` | — |
| On-screen receipt fallback | `WORKS` | `OnScreenReceiptModal.tsx` + `printer.ts:532-574` HTML generation | — |
| Barcode scanner | `WORKS` | `barcodeScanner.ts` — keyboard HID buffer (50ms interval), dispatches `barcode-scanned` event | Simple listener, no Rust |

### 2. Menu Management

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Category CRUD with colors | `WORKS` | `menu/page.tsx` — full CRUD with color picker, sort order | Frontend Kysely |
| Menu item CRUD with barcode | `WORKS` | `menu/page.tsx` — price/cost cents, barcode, image, recipe_id (always null on create) | — |
| Combo meal builder | `WORKS` | `menu/page.tsx:510-565` — `combo_meals` + `combo_items`, bundle pricing, free items, sort order | Admin UI works |
| Happy hour rules (per-day, time ranges) | `WORKS` | `menu/page.tsx:625-679` — day_of_week, start/end time, discount_percent CRUD | Admin UI works |
| **Happy hour affects POS pricing** | `STUB` | `happyHourStore.ts:27-43` has working time-check logic but **zero callers** in POS | No consumer: happyHourStore is never imported |
| **Combo affects POS pricing** | `PARTIAL` | `menuStore.ts:70-83` fetches combo components; `MenuGrid.tsx:23-36` shows savings label | Combo pricing shown but no cart integration to bundle-price |
| Recipe-to-ingredient linking | `PARTIAL` | Schema has `recipes` table, menu item create accepts `recipe_id` param but defaults to `null` | Admin can link, no runtime consumption |

### 3. Inventory

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Ingredient CRUD + stock levels | `WORKS` | `inventory/page.tsx:621-830` — name, unit, cost, stock, min_stock, barcode | Frontend Kysely |
| Manual stock add/remove with reason | `WORKS` | `inventory/page.tsx:313-341` — adjusts `current_stock`, inserts `inventory_logs` | Frontend Kysely |
| Low-stock alerts | `WORKS` | `inventory/page.tsx:1831-1945` — auto-detect `current_stock < min_stock`, auto-order button | Frontend Kysely |
| Supplier CRUD | `WORKS` | `inventory/page.tsx:834-971` — name, phone, email, order totals | Frontend Kysely |
| Purchase order creation with line items | `WORKS` | `inventory/page.tsx:1339-1447` — supplier, items with qty/cost, `purchase_order_items` insert | Frontend Kysely |
| Purchase order receive workflow | `WORKS` | `inventory/page.tsx:1482-1505` — updates `quantity_received`, adds to `ingredients.current_stock`, inserts `inventory_logs`, marks ORDERED→RECEIVED | Frontend Kysely |
| PO cancel action | `WORKS` | `inventory/page.tsx:1536-1557` — marks PENDING/ORDERED→CANCELLED | Frontend Kysely |
| PO detail view | `WORKS` | `inventory/page.tsx:1560-1635` — line items with ordered/received qty, total cost | Frontend Kysely |
| Movement history with filters | `WORKS` | `inventory/page.tsx:1637-1829` — date range, type, material filters | Frontend Kysely |
| **Recipe-based stock depletion** | `FICTION` | `orderService.ts` — no code touches `ingredients.current_stock` when an order is placed | Schema exists, zero runtime consumption |

### 4. Kitchen Display

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Live order feed | `WORKS` | `kds/page.tsx` — polls via `get_kitchen_orders()` Rust command every 3s | Rust command works but has zero role checks |
| Status progression (PENDING→PREPARING→READY) | `WORKS` | `kds/page.tsx` — buttons call `update_order_status()` Rust command | No validation on status string |
| Items grouped by order with table name | `WORKS` | Rust command returns `Vec<KitchenOrder>` with items and modifiers | — |
| Auto-refresh | `WORKS` | `setInterval` 3s in KDS page | — |

### 5. Staff Management

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Employee CRUD | `WORKS` | `staff/page.tsx:307-379` — name, role, phone (Saudi format), photo, CV, QR badge | Frontend Kysely |
| QR badge generation | `WORKS` | `staff/page.tsx:175,367` — uses `qrcode` library | — |
| Activate/deactivate employees | `WORKS` | `staff/page.tsx` — `is_active` flag toggle | — |
| Shift management (open/close) | `WORKS` | `staff/page.tsx:185-217` — starting/ending cash, force-close by manager | Frontend Kysely |
| Shift discrepancy alerts | `WORKS` | `staff/page.tsx:411-431` — `>5000` cents threshold warning | Frontend Kysely |
| Attendance clock-in | `WORKS` | `staff/page.tsx:433-508` — inserts/updates `attendance` record | Frontend Kysely |
| Late detection (after 9 AM) | `WORKS` | `staff/page.tsx:441` — `hours > 9 \|\| (hours === 9 && minutes > 0) → LATE` | — |
| Clock-out with half-day detection | `WORKS` | `staff/page.tsx:494` — `totalHours < 4 → HALF_DAY` | — |
| Attendance history with filters | `WORKS` | `staff/page.tsx:942-1033` — date range, employee filter | Frontend Kysely |
| Status badges (PRESENT/LATE/HALF_DAY/ABSENT) | `WORKS` | `staff/page.tsx` — badge per employee card | — |

### 6. Delivery Management

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Driver CRUD with vehicle types | `WORKS` | `deliveryService.ts` + `delivery/page.tsx` — CAR/MOTORCYCLE/BIKE/VAN/TRUCK | Frontend Kysely |
| Driver availability toggle | `WORKS` | `deliveryService.ts` — AVAILABLE/BUSY/OFFLINE/INACTIVE | — |
| Delivery zone CRUD with fee config | `WORKS` | `deliveryService.ts` — boundaries (JSON), fee_cents, min_order_cents, est_minutes | Frontend Kysely |
| Driver assignment in POS | `WORKS` | `pos/page.tsx` — `DriverSelectModal`, sets order `driver_id` | — |
| Delivery log with 6-state tracking | `WORKS` | `deliveryService.ts` — status progression with timestamps | Frontend Kysely |
| Distance calculation | `WORKS` | `deliveryService.ts` — utility function | No real geocoding API |

### 7. Customer Management

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Customer CRUD | `WORKS` | `customers/page.tsx` — name, phone, email, total_orders, total_spent | Frontend Kysely |
| Customer detail with order history | `WORKS` | `customers/page.tsx` — order list per customer | Frontend Kysely |
| Debt tracking with payment plans | `WORKS` | `debt/page.tsx` — debtor CRUD, debt/payment entries, balance tracking | Frontend Kysely + Rust `get_debtors`, `add_debt`, `record_debt_payment` |

### 8. Finance & Accounting

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Revenue dashboard with date range | `WORKS` | `finance/page.tsx:152-197` — orders+payments aggregation, today/week/month/custom | Frontend Kysely |
| Payment method breakdown | `WORKS` | `finance/page.tsx` — per-method totals table | — |
| Operational cost CRUD | `WORKS` | `finance/page.tsx:268-299` — category selector, cost summary | Frontend Kysely |
| Invoice creation with period/amount/due date | `WORKS` | `finance/page.tsx:301-348` — create modal, PENDING status | Frontend Kysely |
| Invoice detail view + pay action | `WORKS` | `finance/page.tsx` — PENDING→PAID status update | — |
| Pending/overdue totals summary | `WORKS` | `finance/page.tsx` — status-based aggregation | — |
| Tax summary display | `WORKS` | `finance/page.tsx:215-223` — `orders.tax_cents` aggregation | Frontend Kysely |
| CSV export for all tabs | `WORKS` | `finance/page.tsx:235-266` — csv content generation + download | — |
| **ZATCA e-invoicing** | `FICTION` | No ZATCA API, UBL XML, or cryptographic stamp anywhere | Saudi fiscal compliance not implemented |

### 9. Loyalty Program

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Tier system (Bronze/Silver/Gold/Platinum) | `WORKS` | `loyalty/page.tsx:13-20` — thresholds at 0/100/500/2000 points, multipliers 1/1.5/2/3 | Tier calculation is derived, not persisted |
| Card issuance from customer list | `WORKS` | `loyalty/page.tsx:83-101` — unique card number, BRONZE tier, 0 points | — |
| Card search (name/card/phone) | `WORKS` | `loyalty/page.tsx:103-213` — search + tier display | — |
| Transaction history with type filter | `WORKS` | `loyalty/page.tsx:215-263` — EARN/REDEEM/ADJUST/EXPIRE filter | — |
| QR scan-to-earn | `WORKS` | `loyalty/page.tsx` — QR code per card for scanning | — |
| **Points earning in POS on payment** | `WORKS` | `pos/page.tsx:277-300` — `floor(totalCents/100)` points, updates `loyalty_cards`, inserts `loyalty_transactions` | Frontend Kysely |
| **Points redemption in POS** | `STUB` | No code in `pos/page.tsx` handles redemption. Loyalty scan in POS only looks up card for earning | Redemption UI/flow missing |
| Tier multiplier applied to point earning | `STUB` | `TIER_CONFIG.multiplier` defined but never used — POS always awards `floor(totalCents/100)` | Multiplier exists in config, zero consumers |

### 10. AI Assistant

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Chat interface | `WORKS` | `ai/page.tsx` — message bubbles, input, send button | — |
| Owner-only access | `WORKS` | `ai/page.tsx` — `user?.role !== "OWNER"` redirect, navbar checks `canAccessAi` | Permission check is frontend-only React, no Rust guard |
| 6 quick-action buttons | `WORKS` | `ai/page.tsx:14-21` — sales, low stock, attendance, active orders, top items, debt | — |
| Typing indicator, timestamps | `WORKS` | `ai/page.tsx` — typing state, message timestamps | — |
| **Natural-language understanding** | `FICTION` | `ai/page.tsx:48-160` — pure keyword matching (`q.includes("مبيعات")`), no AI/LLM API call | Hardcoded Arabic keyword → SQL query router |
| **Any AI/LLM integration** | `FICTION` | No OpenAI, Claude, or any LLM import or invoke exists | The word "AI" in the product name is aspirational |

### 11. Settings

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Currency, tax mode config | `WORKS` | `settings/page.tsx` — reads/writes `chain_config` via `get_settings()`/`update_settings()` Rust commands | — |
| Printer CRUD | `WORKS` | `settings/page.tsx` — printer config (type, interface, IP, port, paper width) | Frontend Kysely |
| Branch configuration | `WORKS` | `settings/page.tsx` + `branches/page.tsx` — name, address, phone, timezone, max_tables | Frontend Kysely |
| Subscription plan comparison | `WORKS` | `settings/page.tsx` — Starter/Pro/Enterprise matrix (hardcoded UI) | Feature gating is only UI, `license.ts` always returns active |
| Database backup | `FICTION` | `backup.ts` — stores metadata `{snapshot: "snapshot-{timestamp}"}` placeholder in localStorage, **never reads or dumps the actual SQLite DB** | No SQLite backup API, no `.backup` command |
| Database restore | `FICTION` | No restore code exists anywhere | — |
| Auto-backup toggle | `STUB` | UI toggle exists in settings, no scheduler or background worker | — |
| **Cloud Sync tab** | `FICTION` | `settings/page.tsx:605-629` — placeholder with "قريباً" banner, **zero sync code** | No sync engine, no API client, no WebSocket |
| **Real CSP** | `FICTION` | `tauri.conf.json` — `"security": { "csp": null }` | CSP is null, CLAUDE.md lists this as a known regression |

### 12. Multi-Branch

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Branch CRUD | `WORKS` | `branches/page.tsx` — create/read/update/delete with full fields | Frontend Kysely |
| Per-branch timezone/currency/tax | `WORKS` | Fields exist in DB and CRUD UI | — |
| **Branch switching** | `FICTION` | No UI to switch active branch. `current_branch` is implicitly `'main'` | Single-tenant only at runtime |
| **Cross-branch reporting** | `FICTION` | No multi-branch aggregation in reports | — |

### 13. Reporting

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Today's sales summary | `WORKS` | `reports/page.tsx` — total, orders, avg order value for today | Frontend Kysely |
| Top items (by qty/revenue) | `WORKS` | `reports/page.tsx` — today's top items | — |
| Staff performance (hours) | `WORKS` | `reports/page.tsx` — clock-in/out, hours worked | — |
| Inventory status (low stock) | `WORKS` | `reports/page.tsx` — items where `current_stock < min_stock` | — |
| PDF export | `WORKS` | `reports/page.tsx` — jsPDF generation | — |
| **Historical/period reports** | `FICTION` | No date range picker, no month-over-month, no year-over-year | Today-only data |
| **Analytics charts/graphs** | `FICTION` | No chart library, no visualizations | Tables only |

### 14. Debt Management

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| Debtor CRUD | `WORKS` | `debt/page.tsx` + Rust `create_debtor`, `update_debtor`, `delete_debtor` | — |
| Debt entry with order link | `WORKS` | `add_debt()` Rust command — inserts DEBT entry, increments balance | `created_by` is caller-supplied, no auth |
| Payment recording | `WORKS` | `record_debt_payment()` Rust command — inserts PAYMENT entry, decrements balance | Same auth gap |
| Balance tracking | `WORKS` | `debtors` table — `total_debt_cents`, `total_paid_cents`, `balance_cents` | — |
| Per-debtor transaction history | `WORKS` | `get_debtor_detail()` Rust command — debtor + all entries | — |

### 15. Printing

| Claim | Status | Evidence | Gap |
|-------|--------|----------|-----|
| ESC/POS buffer generation | `WORKS` | `printer.ts:51-105` — `createEscPosBuffer()` with initialization, bold, font size, alignment, code page, cash drawer, cut | — |
| Arabic receipt generation | `WORKS` | `printer.ts:109-273` — `generateEscPosReceipt()` with RTL layout, modifiers, tax, discount | — |
| Kitchen ticket generation | `WORKS` | `printer.ts:277-332` — `generateEscPosKitchenTicket()` with beep command | — |
| USB printing via WebUSB | `WORKS` | `printer.ts:336-353` — `device.open()`, `claimInterface(0)`, `transferOut(1, data.buffer)` | Requires WebUSB-compatible browser + secure context |
| Network printing via HTTP POST | `WORKS` | `printer.ts:355-368` — `fetch("http://${ip}:${port}", POST, raw bytes)` | Raw ESC/POS over HTTP to network printer |
| Bluetooth printing | `STUB` | Interface type defined at line 45, BLUETOOTH case falls through to file download | No transport code |
| Print from active printers in DB | `WORKS` | `printReceipt():379-434`, `printKitchenTicket():436-496` — queries printer configs, tries primary/secondary | Frontend Kysely |
| Cash drawer kick | `WORKS` | `printer.ts:499-530` — `openCashDrawer()` sends ESC/POS pulse through receipt printer | — |
| Print queue with retry | `WORKS` | `printer.ts:603-639` — localStorage-based queue, retry on reconnect | — |

### 16. Login & Auth — v0.1 Gaps

| Issue | Status | Evidence |
|-------|--------|----------|
| Seed users with known passwords (`admin123`) | **KNOWN REGRESSION** | `lib.rs:598-630` — 4 users seeded on first run |
| Password hash comparison in renderer | **KNOWN REGRESSION** | `auth.ts` — `verifyPassword()` uses bcryptjs compare in frontend |
| `lib/license.ts` returns `active` unconditionally | **KNOWN REGRESSION** | `license.ts:12-13` — always returns `{ status: "active", daysRemaining: 365 }` |
| `CSP: null` in `tauri.conf.json` | **KNOWN REGRESSION** | Config has `"security": { "csp": null }` |
| `debug/page.tsx` reachable in release build | **KNOWN REGRESSION** | Page exists at `src/app/debug/page.tsx`, no compile-time gating |
| Ad-hoc `ALTER TABLE` with no version table | **KNOWN REGRESSION** | `lib.rs:566-596` — ALTER TABLE wrapped in `.ok()` in init_db() |
| Permission checks in React only | **KNOWN REGRESSION** | All `canAccessX()` functions in `permissions.ts` have no Rust counterpart |
| Rust commands: zero role checks | **WIDESPREAD GAP** | All 17 commands accept any caller, no session verification |
| `audit_logs` table: created, never written to | **WIDESPREAD GAP** | `lib.rs:182` creates table, zero commands insert into it |
| Session tokens are `zaeem_{uuid}` in localStorage | **SECURITY GAP** | `lib.rs:718-790` — session tokens are `zaeem_` + uuid, no expiry |

---

## Summary Counts

### Architecture Compliance (vs CLAUDE.md)

| Rule | Status |
|------|--------|
| R1 — Frontend never touches DB | **FAIL** — 37 `getDb()` call sites |
| R2 — No country logic in core | **PASS** — but only because there's no `core/` module yet |
| R3 — Money type (not bare `_cents`) | **FAIL** — all money is `_cents: i64` everywhere |
| R4 — Orders/payments append-only | **FAIL** — orders are UPDATEd in place |
| R5 — Every mutation writes audit entry | **FAIL** — audit_logs table is dead |

### Feature Status Count (per README claims)

| Status | Count | % |
|--------|-------|---|
| `WORKS` | 53 | 56% |
| `PARTIAL` | 5 | 5% |
| `STUB` | 7 | 7% |
| `FICTION` | 12 | 13% |
| `KNOWN REGRESSION` | 7 | 7% |
| `WIDESPREAD GAP` | 4 | 4% |
| **Architecture FAIL** | 5 | 5% |

### The specific items called out in T0.1

| Item | Verdict | Detail |
|------|---------|--------|
| Split/merge/transfer bill | `WORKS` | Full transactional logic in orderService.ts |
| Purchase order receive | `WORKS` | Updates stock + logs in inventory/page.tsx:1482-1505 |
| ESC/POS network printing | `WORKS` | printer.ts:355-368 — HTTP POST to network printer |
| Barcode scanner | `WORKS` | barcodeScanner.ts — keyboard HID buffer @ 50ms |
| Happy hour | `STUB` | Admin CRUD works. Runtime check exists but has zero callers |
| Combo pricing | `PARTIAL` | Admin CRUD works. MenuGrid shows savings label. No cart pricing integration |
| Recipe-based stock depletion | `FICTION` | Schema exists. No code decrements stock on order |
| AI page | `FICTION` (AI claim) | Keyword→SQL router. No AI, no LLM |
| Cloud sync | `FICTION` | Schema columns exist. Zero sync code anywhere |
| Backup/restore | `FICTION` (backup) | localStorage metadata only. Never touches DB file |

---

## The 5 findings that most change how long Sprint 01 will take

1. **37 `getDb()` call sites must be moved to Rust** — Every order, payment, inventory, menu, staff, delivery, loyalty, and settings operation currently bypasses Rust entirely. Sprint 01's command inventory (T1.0) will be closer to 130-150 commands, not 90-130. The migration touches every store, every lib service, and most pages.

2. **Zero role checks exist on any Rust command** — The 17 commands that do exist have no auth, no session verification, no permission check. Before the frontend migration can land, the auth/RBAC skeleton must exist. This creates a dependency: T1.2 (RBAC) must precede most of T1.6 (frontend migration).

3. **`audit_logs` is a dead table** — No command writes to it. The hash-chained audit chain (Ed25519, seq, prev_hash) doesn't exist at all — not even the table columns for it. This means T1.4 is not an "add signing to existing audit" task but a "build the audit table from scratch and instrument every command" task.

4. **The current README is aspirational** — 12 `FICTION` claims and 7 `STUB` claims mean the README cannot be trusted by anyone. The honest README rewrite (T0.1 second step) will delete more than it keeps. This matters because sprint scoping was based on the README.

5. **Combined, the Money type migration (S2) and the append-only migration (S1) conflict** — Money is stored as `_cents: i64` in 30+ columns across 39 tables. The migration to `MoneySnapshot` (T2.6) and the prohibition on `UPDATE` for money (R4) mean many columns need simultaneous schema + code changes. If S1 makes orders append-only but keeps `_cents`, the S2 migration has to re-migrate those same tables a second time. The two sprints should be re-sequenced or the money migration moved into S1.

---

## Things in the codebase that alarmed me and aren't in any sprint file

1. **`diagnose_db` opens a second `Connection`** (`lib.rs:1122`) — bypassing the `Mutex<Connection>` state, inviting concurrent write races. This command exists for debugging but could corrupt the DB if called during a write.

2. **`update_order_status` accepts arbitrary strings** (`lib.rs:1047`) — no validation against the `orders.status` CHECK constraint. A caller could set status to `"FAKE"` and it would be stored. This makes the "status" column semantically meaningless as an enum.

3. **`change_password` has no caller verification** (`lib.rs:821`) — `user_id` is a parameter, not derived from auth. Any user who knows another user's old password can change it. Worse: there's no rate limiting, no current-password re-verification.

4. **POS loyalty earning is silently wrapped in try/catch** (`pos/page.tsx:299`) — if loyalty point earning fails during payment, the payment succeeds and the error is silently swallowed. The customer gets their food but loses their points. In Syrian inflation, losing points is losing real value.

5. **Payment flow is not transactional** (`pos/page.tsx:190-306`) — order creation, payment insertion, table free, loyalty points, and print are sequential await calls with no transaction wrapping. If the app crashes between "insert payment" and "free table", the table stays OCCUPIED but the order is PAID.

6. **`lib/license.ts` is not just a stub — it's dangerous** — Returns `active` unconditionally. If someone builds a feature gate on it (which the subscription page UI hints at), the gate is trivially bypassed. The CLAUDE.md says to delete it in S1 but there's no sprint task that explicitly says to add `EntitlementAdapter`.

7. **The DB file path is never configurable** — Hardcoded as `sqlite:zaeem_pos.db` in `db/index.ts`. On Windows this resolves to `%APPDATA%/com.zaeem.pos/zaeem_pos.db` but there's no backup path, no USB fallback, no user selectable location.
