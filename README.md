# زعيم نقاط البيع — Zaeem POS

> The definitive Restaurant Operating System for the Middle East.

**Version** 0.1.0 · **Identifier** `com.zaeem.pos` · **© 2026 Wenzdes**

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack](#2-tech-stack)
3. [Architecture](#3-architecture)
4. [Database Schema (35 Tables)](#4-database-schema)
5. [User Roles & Permissions](#5-user-roles--permissions)
6. [Pages & Features](#6-pages--features)
7. [Modals (8)](#7-modals)
8. [Zustand Stores (8)](#8-zustand-stores)
9. [Services & Libraries (13)](#9-services--libraries)
10. [Rust Backend (16 Commands)](#10-rust-backend)
11. [Login Credentials](#11-login-credentials)
12. [Project Structure](#12-project-structure)
13. [Development](#13-development)
14. [Building & Packaging](#14-building--packaging)

---

## 1. Overview

Zaeem POS is a **desktop-native** restaurant management system built with Tauri v2. It runs on Windows, Linux, and macOS as a standalone executable with no browser or server required. The entire state lives in a local SQLite database.

### What it does

| Area | Capabilities |
|------|-------------|
| **Point of Sale** | Table management, item entry, modifiers, split/merge/transfer bills, barcode scanning, multiple payment methods, receipt printing (USB/Network) |
| **Menu Management** | Categories with colors, menu items with barcodes, combo meals, happy-hour time-based discounts, cost tracking |
| **Inventory** | Ingredient stock tracking, supplier management, auto low-stock alerts, purchase orders with receive workflow, movement audit log |
| **Kitchen Display** | Live order feed with status progression (Pending → Preparing → Ready), sorted by oldest first |
| **Staff Management** | Employee CRUD with QR badges, attendance clock-in/out with late (9 AM+) and half-day (<4 hrs) detection, attendance history, cash shift management with discrepancy alerts |
| **Delivery Management** | Driver management (car/motorcycle/bike/van/truck), delivery zones with fee config, delivery log tracking, driver assignment in POS |
| **Customer Management** | Customer profiles with order history, debt tracking with payment plans |
| **Finance & Accounting** | Revenue dashboard with date range filtering, operational cost tracking, invoice creation & payment, tax summary with CSV export for VAT returns |
| **Loyalty Program** | Tiered loyalty cards (Bronze/Silver/Gold/Platinum), points earning on POS purchases, scan-to-earn, point multipliers per tier |
| **AI Assistant** | Premium owner-only chat interface: natural-language queries for sales, inventory, attendance, active orders, top items, and debts |
| **Multi-Branch** | Branch configuration with per-branch timezone, currency, tax rates, and table limits |
| **Reporting** | Data-driven reports and analytics |
| **Settings** | Currency, tax mode (inclusive/exclusive), printer configuration, branch setup, subscription plan comparison, database backup/restore |
| **Debt Management** | Full debtor ledger with debt/payment entries, balance tracking |

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop Shell** | Tauri 2.11.3 |
| **Frontend** | React 18 + TypeScript + Vite 5 |
| **Styling** | Tailwind CSS (custom preset: emerald palette, Inter + IBM Plex Sans Arabic) |
| **State** | Zustand (8 stores) |
| **Database** | SQLite via `@tauri-apps/plugin-sql` + Kysely ORM with custom `TauriSqliteDialect` |
| **Rust DB** | rusqlite 0.31 (bundled, WAL mode, foreign keys enforced) |
| **Auth** | bcrypt (password hashing), session-based token (`zaeem_{uuid}`) |
| **Validation** | Zod |
| **Icons** | lucide-react |
| **PDF** | jsPDF + jspdf-autotable |
| **QR** | qrcode |
| **Other** | jose (JWT), tauri-plugin-log |

### Conventions

- **Monetary values** stored as **integer cents** everywhere — no floating-point rounding
- **Arabic-first** with `dir="rtl"` on every page
- **Offline-first**: all data lives locally in SQLite; sync_queue table for future cloud sync
- **Lazy-loaded** pages with `React.lazy` + `Suspense` for fast initial load

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
│  │  16 Tauri Commands, SQLite via rusqlite │   │
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
3. **Rust commands** handle auth, debt, and kitchen operations via rusqlite directly
4. **Printing** goes through the printer service → ESC/POS → USB/Network/Bluetooth
5. **Barcode scans** come through a Tauri event listener → dispatch custom DOM events

---

## 4. Database Schema

35 tables organized by domain:

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
| `orders` | id, table_id, user_id, status (9 states), order_type (4 types), subtotal/tax/total/discount_cents, customer_name/phone, delivery_address/zone_id/driver_id, scheduled_at | → tables(id), → users(id) |
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
| `purchase_orders` | id, supplier_id, status (PENDING/ORDERED/RECEIVED/CANCELLED), total_cents | → suppliers(id) |
| `purchase_order_items` | id, purchase_order_id, ingredient_id, quantity_ordered, quantity_received, unit_cost_cents | → purchase_orders(id), → ingredients(id) |

### Staff & Attendance
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `shifts` | id, user_id, opened_at, closed_at, starting_cash_cents, ending_cash_cents, difference_cents | → users(id) |
| `attendance` | id, user_id, date, clock_in, clock_out, status (PRESENT/ABSENT/LATE/HALF_DAY) | → users(id) |

### Delivery
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `drivers` | id, name, phone, vehicle_type (CAR/MOTORCYCLE/BIKE/VAN/TRUCK), status (AVAILABLE/BUSY/OFFLINE/INACTIVE), total_deliveries, rating | — |
| `delivery_zones` | id, name, boundaries (JSON), fee_cents, min_order_cents, estimated_minutes | — |
| `delivery_logs` | id, order_id, driver_id, status (6 states with timestamps), failure_reason | → orders(id), → drivers(id) |

### Loyalty
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `loyalty_cards` | id, customer_id, card_number (unique), points, tier (BRONZE/SILVER/GOLD/PLATINUM), issued_at, last_used_at | → customers(id) |
| `loyalty_transactions` | id, card_id, points, type (EARN/REDEEM/ADJUST/EXPIRE), reference_type, reference_id | → loyalty_cards(id) |

### Finance
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `invoices` | id, chain_id, period_start, period_end, amount_cents, status (PENDING/PAID/OVERDUE/CANCELLED), due_date, paid_at | — |
| `operational_costs` | id, category, amount_cents, date, branch_id, user_id | → users(id) |

### Debt
| Table | Key Columns | Foreign Keys |
|-------|-------------|--------------|
| `debtors` | id, name, phone, total_debt_cents, total_paid_cents, balance_cents, is_active | — |
| `debt_entries` | id, debtor_id, order_id, amount_cents, type (DEBT/PAYMENT) | → debtors(id) |

### Configuration
| Table | Key Columns |
|-------|-------------|
| `chain_config` | id='default', chain_name, tax_mode, tax_rate_cents, currency, auto_print settings, barcode_prefix/suffix, customer_display settings |
| `branches` | id, name, address, city, phone, timezone, currency, tax_rate_cents, max_tables |
| `printers` | id, name, printer_type (RECEIPT/KITCHEN/LABEL), interface (USB/NETWORK/BLUETOOTH), ip_address, port, paper_width_mm, code_page |
| `terminals` | id, branch_id, name, version, status (ACTIVE/INACTIVE/OFFLINE) |
| `app_settings` | key (PK), value |

### Support
| Table | Key Columns |
|-------|-------------|
| `combo_meals` | id, name, bundle_price_cents |
| `combo_items` | id, combo_id, menu_item_id, quantity, is_free, sort_order |
| `happy_hour_rules` | id, menu_item_id, discount_percent, day_of_week, start/end_time |
| `delayed_orders` | id, order_id, scheduled_at, activated |
| `customers` | id, name, phone, email, total_orders, total_spent_cents, loyalty_points |
| `audit_logs` | id, user_id, action, entity_type, entity_id, old/new_value |
| `sync_queue` | id, table_name, operation (INSERT/UPDATE/DELETE), record_id, retry_count |
| `login_sessions` | id, user_id, login_time, logout_time, device_info |
| `notifications` | id, user_id, title, message, type, is_read |

---

## 5. User Roles & Permissions

### Roles

| Role | Access Level |
|------|-------------|
| `OWNER` | Full system access — all 14 nav items including AI Assistant, Loyalty, Branches, Finance |
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

### 1. `pos/page.tsx` — Point of Sale (513 lines)
- Table grid (FREE/OCCUPIED/MERGED status)
- Category dock + menu grid with virtualized rendering
- Left panel: cart items with quantity controls, modifiers, void
- Right panel: order summary, subtotal/tax/total, discount
- Order type selector: DINE_IN / TAKEAWAY / DELIVERY / ONLINE
- Customer info inputs for non-dine-in orders
- Driver selection for delivery orders
- **Loyalty card scanning** with points earning on payment
- Barcode scanner integration
- Modals: Payment, Split Bill, Merge Tables, Transfer Order, Void Item, Manager PIN, On-Screen Receipt, Driver Select
- Keyboard shortcuts: F1-F5

### 2. `menu/page.tsx` — Menu Management (≈1500 lines)
- Category CRUD with drag-and-drop sort order
- Menu item CRUD with price, cost, barcode, image
- Combo meal builder (bundle pricing, free items)
- Happy hour rules per day-of-week with time ranges
- Search and filter

### 3. `inventory/page.tsx` — Inventory (1945 lines)
- **Stock tab**: ingredient list with stock levels, add/remove stock with reason, low-stock indicators, edit ingredients
- **Suppliers tab**: supplier CRUD, purchase order creation
- **Movements tab**: inventory log with date/type/material filters
- **Alerts tab**: auto-detect low-stock items, one-click auto-ordering
- **Purchases tab**: full PO lifecycle — create with line items, receive (auto-updates stock + logs), cancel, detail view

### 4. `staff/page.tsx` — Staff (1112+ lines)
- **Employees tab**: employee CRUD with photo, CV, QR badge generation, role assignment, activate/deactivate
- **Shifts tab**: cash register shift management with date range + employee filter, force-close for managers, discrepancy alerts (>5000-cents threshold)
- **Attendance tab**: 
  - Today view: employee cards with clock-in/out, PRESENT/LATE/HALF_DAY/ABSENT badges
  - History view: date range filter, employee filter, search button

### 5. `finance/page.tsx` — Finance (773 lines)
- **Revenue tab**: date range selector (today/week/month/custom), totals (revenue/orders/avg), payment method breakdown table, CSV export
- **Costs tab**: operational cost CRUD with category selector (rent, salaries, utilities, etc.), cost summary
- **Invoices tab**: invoice listing with status badges, **create invoice modal** (period, amount, due date, notes), **detail view**, pay invoice action
- **Taxes tab**: tax configuration display, daily tax collected, CSV export for VAT

### 6. `delivery/page.tsx` — Delivery (650 lines)
- **Active tab**: live delivery orders with driver assignment, status tracking
- **Drivers tab**: driver CRUD with photo, vehicle info, rating, availability toggle
- **Zones tab**: delivery zone management with fee/min-order config
- **History tab**: completed delivery log

### 7. `customers/page.tsx` — Customers
- Customer list with search, order count, total spent, loyalty points
- Customer detail with order history

### 8. `debt/page.tsx` — Debt Management
- Debtor CRUD with balance tracking
- Debt entry and payment recording
- Per-debtor transaction history

### 9. `kds/page.tsx` — Kitchen Display
- Real-time order feed from rusqlite (`get_kitchen_orders`)
- Items grouped by order with table name
- Status progression buttons: PENDING → PREPARING → READY
- Auto-refresh

### 10. `branches/page.tsx` — Branches
- Multi-branch CRUD
- Per-branch timezone, currency, tax rate, table limit configuration

### 11. `reports/page.tsx` — Reports
- Data aggregation and visualization

### 12. `settings/page.tsx` — Settings (685 lines)
- **General**: currency, language, timezone
- **Printer**: printer CRUD, paper width (58/80mm), interface type
- **Tax**: tax rate, inclusive/exclusive mode
- **Branch**: branch name, address, phone, max tables, open/close time
- **Subscription**: plan comparison (Starter/Pro/Enterprise) with feature matrix
- **Cloud Sync**: (placeholder) upcoming multi-branch sync features
- **Backup**: one-click DB backup, auto-backup toggle
- **About**: version, system info, support contact

### 13. `shift/page.tsx` — Shift Management
- Cashier shift open/close workflow
- Starting/ending cash reconciliation

### 14. `loyalty/page.tsx` — Loyalty Program
- Tier overview cards (Bronze/Silver/Gold/Platinum with point thresholds and multipliers)
- Card management: issue new cards to customers, search by name/card number/phone
- Card detail: points, tier, last used, progress to next tier
- Transaction history with type filter (EARN/REDEEM/ADJUST/EXPIRE)

### 15. `ai/page.tsx` — AI Assistant (Premium)
- **Owner-only** access; blocks all other roles
- Chat interface with 6 quick-action buttons: sales summary, low stock, attendance, active orders, top items, debt overview
- Natural-language query execution against live database
- Typing indicator, scroll-to-bottom, timestamp display
- "مميز" (Premium) badge

### 16. `debug/page.tsx` — Diagnostics
- Database path and table listing
- System diagnostics

---

## 7. Modals

| Modal | Trigger | Purpose |
|-------|---------|---------|
| **PaymentModal** | Pay button in POS | Multi-method payment (CASH/CARD/WALLET/CREDIT), received amount, change calculation, optional debt recording |
| **SplitBillModal** | Split button | Split current order items into multiple bills |
| **MergeTablesModal** | Merge button | Select source tables and target table to merge |
| **TransferOrderModal** | Transfer button | Move current order to another table |
| **VoidItemModal** | Void button per item | Void item with reason (requires manager PIN if item >2000¢) |
| **ManagerPinModal** | Discount > limit, void > threshold | Manager PIN verification before privileged actions |
| **OnScreenReceiptModal** | Print failure | Display receipt on screen when printer fails |
| **DriverSelectModal** | Delivery order | Select/change driver for delivery order |

---

## 8. Zustand Stores

| Store | Key State | Actions |
|-------|-----------|---------|
| `authStore` | user, isAuthenticated, isLoading | login(), logout(), checkSession(), loginWithRust() |
| `cartStore` | items[], tableId, tableName, discountCents, discountReason | addItem(), removeItem(), updateQuantity(), voidItem(), clearCart(), subtotal(), tax(), total() |
| `menuStore` | items[], categories[], loading, search | fetchMenu(), filteredItems, fetchCategories() |
| `shiftStore` | activeShiftId, isOpen | openShift(), closeShift(), fetchActiveShift() |
| `printerStore` | printers[], activePrinter | fetchPrinters(), setActivePrinter() |
| `orderTypeStore` | orderType, customerName/Phone/Address, driverId, deliveryAddress | setOrderType(), setCustomerName(), setCustomerPhone(), setDriverId(), resetOrderInfo() |
| `happyHourStore` | rules[] | fetchRules(), isHappyHour() |
| `comboStore` | combos[] | fetchCombos(), getComboItems() |

---

## 9. Services & Libraries

| File | Purpose |
|------|---------|
| `lib/auth.ts` | Password hashing (via Tauri invoke `change_password`), local hash comparison |
| `lib/backup.ts` | SQLite `.backup` via Tauri shell commands, export/restore workflows |
| `lib/barcodeScanner.ts` | Barcode scanner event listener, prefix detection, external scanner support |
| `lib/customerDisplay.ts` | Serial-port customer display (pole display) via Tauri |
| `lib/deliveryService.ts` | 30+ functions: driver/zone CRUD, delivery assignment, status progression, distance calculation |
| `lib/license.ts` | License plan enum (Starter/Professional/Enterprise), feature gating, on-prem fallback |
| `lib/logger.ts` | Structured logger with levels, performance timers, ring-buffer, window.__DEBUG logger |
| `lib/orderService.ts` | Order CRUD, kitchen ticket generation, hold/retrieve, split/merge/transfer, delayed order activation |
| `lib/performance.ts` | FPS monitor, memory usage tracker, image cache with LRU eviction, idle detection |
| `lib/printer.ts` | ESC/POS builder, thermal receipt formatting, cash drawer kick, USB/Network printer discovery, retry queue |
| `lib/taxCalculator.ts` | Inclusive/exclusive tax calculation, secondary tax, service charge |
| `lib/validation.ts` | Zod schemas for order items, payments, discounts |

---

## 10. Rust Backend

16 Tauri commands in `src-tauri/src/lib.rs` (1196 lines):

| Command | Parameters | Returns |
|---------|-----------|---------|
| `login` | username, password, device_info | LoginResponse { success, user, token, message } |
| `logout` | user_id | — |
| `check_auth` | user_id | AuthCheckResponse { authenticated, user } |
| `change_password` | user_id, old_password, new_password | bool |
| `get_debtors` | — | Vec\<Debtor\> |
| `get_debtor_detail` | debtor_id | (Debtor, Vec\<DebtEntry\>) |
| `create_debtor` | name, phone, email, address, notes | id (String) |
| `update_debtor` | id, name, phone, email, address, notes | — |
| `delete_debtor` | id | — |
| `add_debt` | debtor_id, amount_cents, notes, created_by, order_id | — |
| `record_debt_payment` | debtor_id, amount_cents, notes, created_by | — |
| `get_kitchen_orders` | — | Vec\<KitchenOrder\> |
| `update_order_status` | order_id, status | — |
| `get_active_orders` | — | Vec\<serde_json::Value\> |
| `get_settings` | — | SettingsData |
| `update_settings` | settings | — |
| `diagnose_db` | — | String |

### Key Backend Details
- **Password hashing**: bcrypt with cost factor 12
- **Session management**: UUID session IDs stored in `login_sessions` table
- **Database diagnostics**: reports path, existence, and all table names
- **Migration system**: `init_db()` runs SCHEMA_SQL then applies ALTER TABLE migrations for columns added later (e.g., `photo_path`, `cv_path`, `qr_code`, `username`, `is_combo`, `delivery_fee_cents`, etc.)

---

## 11. Login Credentials

Four seed users are created on first run (password `admin123` for all):

| Username | Name | Role | Email | ID |
|----------|------|------|-------|-----|
| `owner` | المدير | OWNER | owner@zaeem.com | user-owner-001 |
| `manager` | المشرف | MANAGER | manager@zaeem.com | user-mgr-001 |
| `cashier` | الكاشير | CASHIER | cashier@zaeem.com | user-cash-001 |
| `kitchen` | المطبخ | KITCHEN | kitchen@zaeem.com | user-kit-001 |

---

## 12. Project Structure

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
│   │   ├── ai/page.tsx           # AI assistant (owner)
│   │   └── debug/page.tsx        # Diagnostics
│   ├── components/
│   │   ├── layout/               # Sidebar, TopBar, LeftPanel, RightPanel, CartPanel, TableBar, TableGrid
│   │   ├── ui/                   # ProductCard, MenuCard, VirtualizedMenuGrid, SearchBar
│   │   │                         # CategoryDock, CategoryPill, ActionButton, EmptyState, OrderTypeSelector, LazyImage
│   │   ├── modals/               # SplitBill, TransferOrder, MergeTables, ManagerPin, VoidItem, DriverSelect, OnScreenReceipt
│   │   ├── LoginPage.tsx         # Auth with particle canvas
│   │   ├── PaymentModal.tsx      # Payment processing
│   │   ├── MenuGrid.tsx          # Menu grid with virtualization
│   │   └── SplashScreen.tsx      # Loading screen
│   ├── stores/                   # 8 Zustand stores
│   ├── lib/                      # 13 service/utility files
│   ├── hooks/                    # usePermissions, useKeyboardShortcuts, useCurrency
│   ├── db/                       # schema.sql, types.ts (Kysely), index.ts, migrations.ts, corruption.ts
│   ├── App.tsx                   # Root with routing
│   └── main.tsx                  # Entry point
├── src-tauri/
│   ├── src/lib.rs                # Rust backend (1196 lines)
│   ├── Cargo.toml                # Rust dependencies
│   ├── tauri.conf.json           # Tauri configuration
│   └── icons/                    # App icons
├── package.json
└── README.md
```

---

## 13. Development

### Prerequisites

- **Node.js** 18+
- **pnpm** 8+
- **Rust** 1.77+ (for Tauri)
- **System deps**: See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Run Tauri desktop app with hot reload
npm run tauri dev
```

### Key Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (frontend only) |
| `npm run build` | TypeScript check + production build |
| `npm run tauri dev` | Full Tauri dev mode (hot reload) |
| `npm run tauri build` | Production build + installer package |
| `npm run preview` | Preview production build |

### Code Conventions

- Arabic UI labels, RTL layout (`dir="rtl"`)
- All monetary values in **integer cents** (multiply by 100 on input, divide by 100 on display)
- Kysely for SQL queries; rusqlite only for Rust commands
- Components in `src/components/`, pages in `src/app/*/page.tsx`
- Stores in `src/stores/`, services in `src/lib/`
- Lazy-loaded pages with `React.lazy`

---

## 14. Building & Packaging

```bash
# Production build — creates installers
npm run tauri build
```

This produces:
- **Windows**: `.msi` (Wix) and `.exe` (NSIS) in `src-tauri/target/release/bundle/`
- **Linux**: `.deb` and `.AppImage`
- **macOS**: `.dmg`

The build process:
1. Runs `pnpm build` (TypeScript check + Vite production build)
2. Compiles Rust backend with `--release`
3. Bundles the native installer

### Current Build Output

```
src-tauri/target/release/bundle/
├── msi/zaeem-pos_0.1.0_x64_en-US.msi
└── nsis/zaeem-pos_0.1.0_x64-setup.exe
```

### Configuration

`tauri.conf.json` key settings:
- **App ID**: `com.zaeem.pos`
- **Window**: 1280×900, min 1024×700, resizable
- **Security**: CSP disabled (null) for local SQLite access
- **Bundle**: all targets, icons for all platforms

---

## Design System

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `primary` (emerald) | `#10B981` | Buttons, active states, branding |
| `primary-dark` | `#059669` | Hover states |
| `surface` | `#F8FAFC` | Page background |
| `card` | `#FFFFFF` | Card backgrounds |
| `text-primary` | `#0F172A` | Primary text |
| `text-secondary` | `#64748B` | Secondary/muted text |
| `success` | emerald | Present, paid, active |
| `warning` | amber | Low stock, pending, late |
| `danger` | red | Absent, overdue, voided |
| `info` | blue | Ordered, in-transit |

### Typography

| Usage | Font | Weight |
|-------|------|--------|
| Arabic UI | IBM Plex Sans Arabic | 400/500/700 |
| Monospace | IBM Plex Mono | 400/700 |
| Body | Inter | 400/500/600/700 |

### Border Radius

| Scale | Value |
|-------|-------|
| sm | 8px |
| md | 12px |
| lg | 16px |
| xl | 20px |
| 2xl | 24px |

### Shadows

| Level | Definition |
|-------|-----------|
| card | `0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` |
| card-hover | `0 10px 25px rgba(0,0,0,0.08), 0 4px 10px rgba(0,0,0,0.04)` |
| elevated | `0 20px 60px rgba(0,0,0,0.12), 0 8px 20px rgba(0,0,0,0.06)` |

---

## Notes

- **Database location**: `%APPDATA%/com.zaeem.pos/zaeem_pos.db` (Windows) or equivalent on other platforms
- **First run**: Schema auto-creates 35 tables and seeds 4 default users
- **License**: On-prem by default (`lib/license.ts` returns active)
- **Printing**: ESC/POS protocol over USB, Network (port 9100), or Bluetooth
- **Barcode**: Configurable prefix/suffix in chain_config
- **Offline**: All features work 100% offline — no internet connection required
