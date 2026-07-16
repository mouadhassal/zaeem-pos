# زعيم نقاط البيع — Zaeem POS

> Restaurant operating system for the Middle East.

**Version** 0.1.0 · **Identifier** `com.zaeem.pos` · **© 2026 Wenzdes**

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Database Schema](#4-database-schema)
5. [User Roles & Permissions](#5-user-roles--permissions)
6. [Pages & Features](#6-pages--features)
7. [Modals](#7-modals)
8. [Zustand Stores](#8-zustand-stores)
9. [Services & Libraries](#9-services--libraries)
10. [Rust Backend](#10-rust-backend)
11. [Project Structure](#11-project-structure)
12. [Development](#12-development)

---

## 1. Overview

Zaeem POS is a **desktop-native** restaurant management system built with Tauri v2. It runs on Windows, Linux, and macOS as a standalone executable with no browser or server required. The entire state lives in a local SQLite database.

### What works

| Area | Capabilities | Status |
|------|-------------|--------|
| **Point of Sale** | Table management, item entry, modifiers, split/merge/transfer bills, barcode scanning, CASH payment with change calculation, receipt printing (USB/Network), hold/retrieve drafts, delayed/scheduled orders | WORKS |
| **Menu Management** | Categories with colors, menu items with barcodes, combo meals, happy-hour time-based discount rules | WORKS |
| **Inventory** | Ingredient stock tracking, supplier management, purchase orders with receive workflow, movement audit log, low-stock alerts | WORKS |
| **Kitchen Display** | Live order feed with status progression (Pending → Preparing → Ready) | WORKS |
| **Staff Management** | Employee CRUD with QR badges, attendance clock-in/out with late and half-day detection, cash shift management with discrepancy alerts | WORKS |
| **Delivery Management** | Driver management, delivery zones with fee config, driver assignment in POS | WORKS |
| **Customer Management** | Customer profiles with order history, debt tracking with payment plans | WORKS |
| **Finance** | Revenue dashboard (today/week/month), operational cost tracking, invoice creation, CSV export | WORKS |
| **Loyalty Program** | Tiered loyalty cards, points earning on POS purchases, scan-to-earn | WORKS (redemption not yet implemented) |
| **Printing** | ESC/POS receipt and kitchen tickets over USB and network, cash drawer, print queue with retry | WORKS |
| **Debt Management** | Full debtor ledger with debt/payment entries, balance tracking | WORKS |
| **Settings** | Currency, tax mode, printer config, branch config | WORKS |
| **Reports** | Today's sales, top items, staff hours, low stock, PDF export | PARTIAL — today's data only, no historical trends or charts |

### Not yet built

These features have schema columns or UI placeholders but no working implementation:
- **AI/LLM**: The AI page is a keyword→SQL router, not natural language. No LLM is integrated.
- **Cloud sync**: Schema has a `sync_queue` table. No sync engine exists.
- **Backup/restore**: UI toggle exists. No SQLite backup or restore code.
- **ZATCA e-invoicing**: Saudi fiscal compliance not implemented.
- **Multi-branch switching**: Branch CRUD works. No runtime branch switch or cross-branch reporting.
- **Recipe-based stock depletion**: Schema links recipes to ingredients. No code decrements stock on order placement.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop Shell** | Tauri 2.11.3 |
| **Frontend** | React 18 + TypeScript + Vite 5 |
| **Styling** | Tailwind CSS (emerald palette, Inter + IBM Plex Sans Arabic) |
| **State** | Zustand (8 stores) |
| **Database** | SQLite via `@tauri-apps/plugin-sql` + Kysely ORM |
| **Rust DB** | rusqlite 0.31 (bundled, WAL mode, foreign keys enforced) |
| **Auth** | bcrypt (password hashing), session-based token |
| **Validation** | Zod |
| **Icons** | lucide-react |
| **PDF** | jsPDF + jspdf-autotable |
| **QR** | qrcode |

### Conventions

- **Monetary values** stored as integer cents everywhere — no floating-point
- **Arabic-first** with `dir="rtl"` on every page
- **Offline-first**: all data lives locally in SQLite
- **Lazy-loaded** pages with `React.lazy` + `Suspense`

---

## 3. Architecture

```
┌───────────────────────────────────────────────┐
│                  Tauri Shell                    │
│  ┌─────────────────────────────────────────┐   │
│  │         React SPA (Vite)                │   │
│  │  ┌───────┐ ┌────────┐ ┌────────────┐   │   │
│  │  │Zustand│ │ Kysely │ │ 16 Lazy    │   │   │
│  │  │Stores │ │ ORM    │ │ Pages      │   │   │
│  │  └───────┘ └────────┘ └────────────┘   │   │
│  │         ↕ tauri:invoke ↕               │   │
│  ├─────────────────────────────────────────┤   │
│  │         Rust Backend (lib.rs)           │   │
│  │  19 Tauri Commands, SQLite via rusqlite │   │
│  └─────────────────────────────────────────┘   │
│         ↕ rusqlite ↕                            │
│  ┌─────────────────────────────────────────┐   │
│  │  SQLite Database (zaeem_pos.db)         │   │
│  │  35 tables, WAL mode, foreign keys      │   │
│  └─────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
```

### Data Flow

1. **UI events** trigger Zustand store actions
2. Stores call **Kysely queries** via `getDb()` → `@tauri-apps/plugin-sql`
3. **Rust commands** handle auth, setup, debt, kitchen operations, and diagnostics via rusqlite
4. **Printing** goes through the printer service → ESC/POS → USB/Network
5. **Barcode scans** come through a Tauri event listener → dispatch custom DOM events

---

## 4. Database Schema

35 tables organized by domain.

### Core Business
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `users` | id, name, email, password_hash, role, is_active, photo_path, cv_path, qr_code, restaurant_id | — |
| `categories` | id, name, color, sort_order, image_path | — |
| `menu_items` | id, name, price_cents, cost_cents, category_id, barcode, is_combo | → categories(id) |
| `tables` | id, name, status (FREE/OCCUPIED/MERGED), merge_group_id | — |

### Orders & Payments
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `orders` | id, table_id, user_id, status (9 states), order_type (4 types), subtotal/tax/total/discount_cents, customer info, delivery fields, scheduled_at | → tables(id), → users(id) |
| `order_items` | id, order_id, menu_item_id, quantity, unit_price_cents, voided, void_reason | → orders(id), → menu_items(id) |
| `order_modifiers` | id, order_item_id, name, price_cents | → order_items(id) |
| `payments` | id, order_id, method (CASH/CARD/WALLET/CREDIT), amount_cents, change_cents | → orders(id) |

### Inventory & Procurement
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `ingredients` | id, name, unit, cost_cents_per_unit, current_stock, min_stock, barcode | — |
| `recipes` | id, menu_item_id, ingredient_id, quantity_needed | → menu_items(id), → ingredients(id) |
| `inventory_logs` | id, ingredient_id, change_amount, reason, user_id | → ingredients(id), → users(id) |
| `suppliers` | id, name, phone, email, total_orders, total_purchases_cents | — |
| `purchase_orders` | id, supplier_id, status, total_cents | → suppliers(id) |
| `purchase_order_items` | id, purchase_order_id, ingredient_id, quantity_ordered/received, unit_cost_cents | → purchase_orders(id), → ingredients(id) |

### Staff & Attendance
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `shifts` | id, user_id, opened_at, closed_at, starting/ending_cash_cents, difference_cents | → users(id) |
| `attendance` | id, user_id, date, clock_in, clock_out, status | → users(id) |

### Delivery
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `drivers` | id, name, phone, vehicle_type, status, total_deliveries, rating | — |
| `delivery_zones` | id, name, boundaries (JSON), fee_cents, min_order_cents, estimated_minutes | — |
| `delivery_logs` | id, order_id, driver_id, status (6 states with timestamps) | → orders(id), → drivers(id) |

### Loyalty
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `loyalty_cards` | id, customer_id, card_number, points, tier, issued_at, last_used_at | → customers(id) |
| `loyalty_transactions` | id, card_id, points, type, reference_type, reference_id | → loyalty_cards(id) |

### Finance
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `invoices` | id, chain_id, period_start/end, amount_cents, status, due_date, paid_at | — |
| `operational_costs` | id, category, amount_cents, date, branch_id, user_id | → users(id) |

### Debt
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `debtors` | id, name, phone, total_debt_cents, total_paid_cents, balance_cents, is_active | — |
| `debt_entries` | id, debtor_id, order_id, amount_cents, type (DEBT/PAYMENT) | → debtors(id) |

### Configuration
| Table | Key Columns |
|-------|-------------|
| `chain_config` | id='default', chain_name, tax_mode, tax_rate_cents, currency, auto_print settings |
| `branches` | id, name, address, city, phone, timezone, currency, tax_rate_cents, max_tables |
| `printers` | id, name, printer_type, interface, ip_address, port, paper_width_mm, code_page |
| `terminals` | id, branch_id, name, version, status |
| `app_settings` | key (PK), value |

### Support
| Table | Key Columns |
|-------|-------------|
| `combo_meals` | id, name, bundle_price_cents |
| `combo_items` | id, combo_id, menu_item_id, quantity, is_free, sort_order |
| `happy_hour_rules` | id, menu_item_id, discount_percent, day_of_week, start/end_time |
| `delayed_orders` | id, order_id, scheduled_at, activated |
| `customers` | id, name, phone, email, total_orders, total_spent_cents |
| `audit_logs` | id, user_id, action, entity_type, entity_id, old/new_value — table exists, no runtime writes |
| `login_sessions` | id, user_id, login_time, logout_time, device_info |
| `notifications` | id, user_id, title, message, type, is_read |

---

## 5. User Roles & Permissions

### Roles

| Role | Access |
|------|--------|
| `OWNER` | Full system access — all nav items |
| `ADMIN` | Same as MANAGER |
| `MANAGER` | POS, Shift, Customers (debt), Menu, KDS, Inventory, Delivery, Reports, Staff, Settings |
| `ACCOUNTANT` | POS, Shift, Reports, Finance |
| `CASHIER` | POS, Shift, Customers (read-only debt) |
| `KITCHEN` | KDS display only |

### Permission Functions

| Function | Roles Allowed |
|----------|--------------|
| `canAccessInventory` | OWNER, ADMIN, MANAGER |
| `canAccessReports` | OWNER, ADMIN, MANAGER, ACCOUNTANT |
| `canAccessStaff` | OWNER, ADMIN, MANAGER |
| `canAccessFinance` | OWNER, ACCOUNTANT |
| `canAccessBranches` | OWNER |
| `canAccessSettings` | OWNER, ADMIN, MANAGER |
| `canManageMenu` | OWNER, ADMIN, MANAGER |
| `getMaxDiscountPercent` | OWNER: 100%, MANAGER: 50%, others: 10% |
| `canVoidAnyOrder` | OWNER, ADMIN, MANAGER |

### Navigation by Role

```
OWNER:       POS | Shift | Debt | Menu | KDS | Inventory | Reports | Staff | Delivery | Branches | Finance | Loyalty | AI | Settings
MANAGER:     POS | Shift | Debt | Menu | KDS | Inventory | Reports | Staff | Delivery | Settings
ACCOUNTANT:  POS | Shift | Reports | Finance
CASHIER:     POS | Shift | Debt
KITCHEN:     KDS
```

---

## 6. Pages & Features

### `pos/page.tsx` — Point of Sale
- Table grid with FREE/OCCUPIED/MERGED status
- Category dock + menu grid
- Cart with quantity controls, modifiers, void
- Order summary with subtotal/tax/total/discount
- Order type selector: DINE_IN / TAKEAWAY / DELIVERY / ONLINE
- Delivery driver selection
- CASH payment with change calculation (CARD/WALLET/CREDIT methods defined but receive the same CASH logic)
- Hold/retrieve draft orders
- Delayed/scheduled orders
- Barcode scanner integration
- Keyboard shortcuts: F1-F5

### `menu/page.tsx` — Menu Management
- Category CRUD with sort order and color
- Menu item CRUD with price, cost, barcode
- Combo meal builder (bundle pricing, free items)
- Happy hour rules (per day-of-week, time ranges, discount percent)
- Search and filter

### `inventory/page.tsx` — Inventory
- Ingredient list with stock levels, add/remove with reason, low-stock indicators
- Supplier CRUD
- Purchase order lifecycle: create with line items, receive (auto-updates stock + logs), cancel, detail view
- Inventory movement log with date/type/material filters
- Low-stock auto-detection with one-click ordering

### `staff/page.tsx` — Staff
- Employee CRUD with photo, CV, QR badge, role assignment, activate/deactivate
- Shift management: open/close cash register, force-close for managers, discrepancy alerts
- Attendance: clock-in/out with late detection (after 9 AM), half-day (<4 hrs), history with filters

### `finance/page.tsx` — Finance
- Revenue tab: today/week/month totals, payment method breakdown, CSV export
- Costs tab: operational cost CRUD with category selector
- Invoices tab: create, list, detail view, pay action
- Taxes tab: daily tax collected display, CSV export

### `delivery/page.tsx` — Delivery
- Active delivery orders with driver assignment
- Driver CRUD with vehicle info, availability toggle
- Delivery zone management with fee/min-order config
- Delivery log

### `customers/page.tsx` — Customers
- Customer list with search, order count, total spent
- Customer detail with order history

### `debt/page.tsx` — Debt Management
- Debtor CRUD with balance tracking
- Debt entry and payment recording
- Per-debtor transaction history

### `kds/page.tsx` — Kitchen Display
- Real-time order feed via Rust command
- Items grouped by order with table name
- Status: PENDING → PREPARING → READY
- Auto-refresh every 3 seconds

### `branches/page.tsx` — Branches
- Branch CRUD with per-branch timezone, currency, tax rate, table limit

### `reports/page.tsx` — Reports
- Today's sales summary (total revenue, orders, average order value)
- Today's top items (by quantity and revenue)
- Staff hours worked
- Low-stock inventory items
- PDF export via jsPDF

### `settings/page.tsx` — Settings
- Currency, tax mode (inclusive/exclusive)
- Printer CRUD (USB/Network, paper width)
- Branch configuration
- Subscription plan comparison (Starter/Pro/Enterprise — UI only, no feature gating)

### `shift/page.tsx` — Shift Management
- Cashier shift open/close with cash reconciliation

### `loyalty/page.tsx` — Loyalty Program
- Tier cards: Bronze/Silver/Gold/Platinum with point thresholds and multipliers
- Card issuance to customers
- Card search by name/card number/phone
- Points earn on POS payment via QR scan
- Transaction history with type filter

### `ai/page.tsx` — AI Assistant
- Owner-only access
- Chat interface with 6 quick-action buttons
- Arabic keyword matching for database queries
- **Not AI/LLM. No language model is integrated.** Queries are hardcoded keyword → SQL.

### `debug/page.tsx` — Diagnostics (dev builds only)
- Database table listing
- Integrity check and WAL mode status

---

## 7. Modals

| Modal | Purpose |
|-------|---------|
| **PaymentModal** | CASH payment with change calculation; other methods accepted but use same logic |
| **SplitBillModal** | Split current order items into multiple bills |
| **MergeTablesModal** | Merge tables, move items to target |
| **TransferOrderModal** | Move order to another table |
| **VoidItemModal** | Void item with reason (requires manager PIN above threshold) |
| **ManagerPinModal** | PIN verification for discounts/voids |
| **OnScreenReceiptModal** | Display receipt when printer fails |
| **DriverSelectModal** | Select/change driver for delivery orders |
| **SetupWizard** | First-run: create owner account with password (min 10 chars) and 6-digit PIN |

---

## 8. Zustand Stores

| Store | Key State | Actions |
|-------|-----------|---------|
| `authStore` | user, token, isAuthenticated, needsSetup | login, logout, checkSession, checkNeedsSetup, setupOwner, changePassword |
| `cartStore` | items, tableId, discount | addItem, removeItem, updateQuantity, voidItem, subtotal, tax, total |
| `menuStore` | items, categories, loading, search | fetchMenu, filteredItems, fetchCategories |
| `shiftStore` | activeShiftId, isOpen | openShift, closeShift, fetchActiveShift |
| `printerStore` | printers, activePrinter | fetchPrinters, setActivePrinter |
| `orderTypeStore` | orderType, customer details, driverId | setOrderType, setCustomerName, setDriverId, resetOrderInfo |
| `happyHourStore` | rules | fetchRules, isHappyHour |
| `comboStore` | combos | fetchCombos, getComboItems |

---

## 9. Services & Libraries

| File | What it actually does |
|------|----------------------|
| `lib/auth.ts` | Password hashing (bcryptjs). Not used in login flow — Rust handles auth. |
| `lib/barcodeScanner.ts` | Keyboard HID buffer (50ms interval), dispatches `barcode-scanned` event with prefix detection |
| `lib/deliveryService.ts` | Driver/zone CRUD, delivery assignment, status progression, distance calculation utility |
| `lib/logger.ts` | Structured logger with levels, performance timers, ring buffer |
| `lib/orderService.ts` | Order CRUD, hold/retrieve, split/merge/transfer, delayed order activation |
| `lib/performance.ts` | FPS monitor, memory usage tracker, image cache with LRU eviction |
| `lib/printer.ts` | ESC/POS buffer builder, receipt/ticket formatting, USB and network printing, cash drawer, print queue with retry |
| `lib/taxCalculator.ts` | Inclusive/exclusive tax calculation, service charge |
| `lib/validation.ts` | Zod schemas for order items, payments, discounts |

---

## 10. Rust Backend

19 Tauri commands in `src-tauri/src/lib.rs`:

| Command | Parameters | Returns |
|---------|-----------|---------|
| `login` | username, password, device_info | LoginResponse { success, user, token, message } |
| `logout` | user_id | — |
| `check_auth` | user_id | AuthCheckResponse |
| `change_password` | session_token, old_password, new_password | bool |
| `needs_setup` | — | bool |
| `setup_owner` | name, username, password, pin | LoginResponse |
| `get_debtors` | — | Vec\<Debtor\> |
| `get_debtor_detail` | debtor_id | (Debtor, Vec\<DebtEntry\>) |
| `create_debtor` | name, phone, email, address, notes | id (String) |
| `update_debtor` | id, name, phone, email, address, notes | — |
| `delete_debtor` | id | — |
| `add_debt` | debtor_id, amount_cents, notes, created_by, order_id | — |
| `record_debt_payment` | debtor_id, amount_cents, notes, created_by | — |
| `get_kitchen_orders` | — | Vec\<KitchenOrder\> |
| `update_order_status` | order_id, status (validated enum) | — |
| `get_active_orders` | — | Vec\<serde_json::Value\> |
| `get_settings` | — | SettingsData |
| `update_settings` | settings | — |
| `diagnose_db` | — | String (tables list) |

### Key Backend Details
- **Password hashing**: bcrypt with cost factor 12
- **Session management**: UUID session IDs in `login_sessions` table, token format `zaeem_{uuid}`
- **First-run**: `needs_setup` checks for any OWNER user. `setup_owner` creates the first account with password (min 10 chars) and 6-digit POS PIN. Seed users exist in debug builds only.
- **Rate limiting**: `change_password` tracks failures in `app_settings`, locks for 1 hour after 10 failed attempts
- **Order status validation**: `update_order_status` validates against the `OrderStatus` enum before writing

---

## 11. Project Structure

```
zaeem-pos/
├── src/
│   ├── app/
│   │   ├── pos/page.tsx          # Point of Sale
│   │   ├── menu/page.tsx         # Menu management
│   │   ├── inventory/page.tsx    # Inventory + Purchase Orders
│   │   ├── staff/page.tsx        # Staff + Attendance + Shifts
│   │   ├── finance/page.tsx      # Finance + Invoices
│   │   ├── delivery/page.tsx     # Delivery management
│   │   ├── customers/page.tsx    # Customer CRM
│   │   ├── debt/page.tsx         # Debt management
│   │   ├── kds/page.tsx          # Kitchen display
│   │   ├── reports/page.tsx      # Reports
│   │   ├── branches/page.tsx     # Branch management
│   │   ├── shift/page.tsx        # Shift management
│   │   ├── settings/page.tsx     # Settings
│   │   ├── loyalty/page.tsx      # Loyalty cards
│   │   ├── ai/page.tsx           # Keyword-query assistant (not AI)
│   │   └── debug/page.tsx        # Diagnostics (dev builds only)
│   ├── components/
│   │   ├── layout/               # Sidebar, TopBar, LeftPanel, RightPanel, CartPanel, TableBar, TableGrid
│   │   ├── ui/                   # ProductCard, MenuCard, CategoryDock, SearchBar, etc.
│   │   ├── modals/               # SplitBill, TransferOrder, MergeTables, ManagerPin, VoidItem, etc.
│   │   ├── LoginPage.tsx
│   │   ├── SetupWizard.tsx       # First-run owner account creation
│   │   ├── PaymentModal.tsx
│   │   ├── MenuGrid.tsx
│   │   └── SplashScreen.tsx
│   ├── stores/                   # 8 Zustand stores
│   ├── lib/                      # 9 service/utility files
│   ├── hooks/                    # usePermissions, useKeyboardShortcuts, useCurrency
│   ├── db/                       # schema.sql, types.ts, index.ts, migrations.ts, corruption.ts
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/
│   ├── src/lib.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
├── docs/
│   ├── FEATURE_TRUTH.md
│   ├── ARCHITECTURE_V2.md
│   └── sprints/
├── package.json
├── AGENTS.md
└── README.md
```

---

## 12. Development

### Prerequisites
- **Node.js** 18+, **pnpm** 8+, **Rust** 1.77+

### Setup

```bash
pnpm install
pnpm dev              # Vite dev server (frontend only)
npm run tauri dev     # Full Tauri dev mode
npm run tauri build   # Production build + installer
```

### Key Commands

| Command | Description |
|---------|-------------|
| `npm run build` | TypeScript check + production build |
| `npm run tauri build` | Production build + installer (.msi/.exe/.deb/.AppImage/.dmg) |

### Code Conventions

- Arabic UI labels, RTL layout (`dir="rtl"`)
- Monetary values in integer cents
- Lazy-loaded pages with `React.lazy`

---

