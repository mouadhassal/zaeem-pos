# Zaeem Ecosystem — AI Agent Sprint Prompts
## Build a $20K-grade POS + Admin + Owner Dashboard + Landing Site

> **Color Palette:** White-first with saffron whisper (see `color-palette.md`)
> **Stack:** Next.js 14 (App Router), TypeScript, Tailwind CSS, tRPC, Prisma, PostgreSQL, NextAuth.js, Zustand, Framer Motion, Socket.io, Redis, Tauri (POS desktop)
> **Monorepo:** Turborepo with `apps/web` (landing), `apps/control` (admin + owner), `apps/pos` (Tauri desktop — already exists), `packages/ui`, `packages/shared`, `packages/db`

---

## SPRINT 0 — Design System & Monorepo Foundation

**Goal:** Establish the architectural backbone, shared design system, and database schema that every other sprint depends on. Nothing ships without this.

**Prompt for AI Agent:**

```
Initialize a Turborepo monorepo with the following structure:

apps/
  web/           — Marketing/landing website (Next.js 14, App Router, static export)
  control/       — Admin + Owner dashboard (Next.js 14, App Router, SSR)
  pos/           — Existing Tauri desktop app (DO NOT MODIFY except for shared package imports)
packages/
  ui/            — Shared React components (shadcn/ui base, customized)
  shared/        — Types, utilities, constants, validation schemas (Zod)
  db/            — Prisma schema + client (shared across control + web if needed)

TECH REQUIREMENTS:
- Next.js 14 with App Router in both web and control
- TypeScript strict mode everywhere
- Tailwind CSS with the following custom config in packages/ui/tailwind.config.ts:
  - colors: saffron-50 through saffron-700 as #FFFBEB, #FEF3C7, #FDE68A, #FCD34D, #FBBF24, #F59E0B, #D97706, #B45309
  - background: canvas #FFFCF7, card #FFFFFF
  - text: primary #0F172A, secondary #475569, muted #94A3B8
  - slate-50 through slate-900 as standard
  - success #16A34A, warning #D97706, danger #DC2626, info #2563EB
  - fontFamily: Inter (Google Fonts) as sans, JetBrains Mono as mono
  - extend: animation fadeSlideUp, fadeSlideDown, float, pulseGlow
  - boxShadow: glow (0 0 24px rgba(245,158,11,0.12)), card (0 1px 3px rgba(15,23,42,0.05), 0 1px 2px rgba(15,23,42,0.03))
- shadcn/ui initialized in packages/ui with the "neutral" base color
- Override all shadcn components to use saffron-500 for primary actions ONLY
- Framer Motion installed in packages/ui for shared animation primitives
- Zustand in packages/shared for state management patterns
- Zod in packages/shared for all validation schemas

DATABASE SCHEMA (Prisma in packages/db/prisma/schema.prisma):

model Tenant {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  plan        Plan     @default(TRIAL)
  status      TenantStatus @default(ACTIVE)
  licenseKey  String   @unique
  expiresAt   DateTime?
  maxBranches Int      @default(1)
  maxUsers    Int      @default(5)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  branches    Branch[]
  users       User[]
  ownerId     String   @unique
  owner       User     @relation(fields: [ownerId], references: [id], name: "TenantOwner")
}

model Branch {
  id          String   @id @default(cuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  address     String?
  phone       String?
  posDeviceId String?  @unique
  isOnline    Boolean  @default(false)
  lastPingAt  DateTime?
  createdAt   DateTime @default(now())
  orders      Order[]
}

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  role          UserRole  @default(OWNER)
  tenantId      String?
  tenant        Tenant?   @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  ownedTenant   Tenant?   @relation(name: "TenantOwner")
  emailVerified DateTime?
  image         String?
  createdAt     DateTime  @default(now())
  accounts      Account[]
  sessions      Session[]
}

model Order {
  id          String   @id @default(cuid())
  branchId    String
  branch      Branch   @relation(fields: [branchId], references: [id], onDelete: Cascade)
  posOrderId  String   // ID from the desktop POS
  type        OrderType
  status      OrderStatus @default(PENDING)
  totalCents  Int
  taxCents    Int
  items       Json     // Array of {name, qty, priceCents, modifiers}
  customerName String?
  customerPhone String?
  deliveryAddress String?
  tableId     String?
  createdAt   DateTime @default(now())
  syncedAt    DateTime @default(now())
}

model License {
  id          String   @id @default(cuid())
  key         String   @unique
  tenantId    String?
  plan        Plan
  status      LicenseStatus @default(UNACTIVATED)
  activatedAt DateTime?
  expiresAt   DateTime
  deviceCount Int      @default(0)
  maxDevices  Int      @default(1)
  createdAt   DateTime @default(now())
}

model ActivityLog {
  id        String   @id @default(cuid())
  tenantId  String?
  userId    String?
  action    String
  details   Json?
  ipAddress String?
  createdAt DateTime @default(now())
}

enum Plan { TRIAL STARTER PROFESSIONAL ENTERPRISE }
enum TenantStatus { ACTIVE SUSPENDED CANCELLED PAST_DUE }
enum UserRole { SUPERADMIN ADMIN OWNER MANAGER STAFF }
enum OrderType { DINE_IN TAKEAWAY DELIVERY DEBT }
enum OrderStatus { PENDING COOKING READY SERVED CANCELLED }
enum LicenseStatus { UNACTIVATED ACTIVE EXPIRED REVOKED }

// NextAuth required models
model Account { id String @id @default(cuid()); userId String; type String; provider String; providerAccountId String; refresh_token String? @db.Text; access_token String? @db.Text; expires_at Int?; token_type String?; scope String?; id_token String? @db.Text; session_state String?; user User @relation(fields: [userId], references: [id], onDelete: Cascade); @@unique([provider, providerAccountId]) }
model Session { id String @id @default(cuid()); sessionToken String @unique; userId String; expires DateTime; user User @relation(fields: [userId], references: [id], onDelete: Cascade) }
model VerificationToken { identifier String; token String @unique; expires DateTime; @@unique([identifier, token]) }

SHARED PACKAGES TO BUILD:
1. packages/ui/src/components/primitives/:
   - Button.tsx (variants: primary [saffron gradient], secondary [white/slate], ghost, danger; sizes: sm, md, lg; with loading state)
   - Card.tsx (white bg, subtle border, shadow-md, rounded-2xl)
   - Input.tsx (focus ring saffron-50 + saffron-400 border)
   - Badge.tsx (variants: saffron, slate, success, warning, danger)
   - Avatar.tsx
   - Skeleton.tsx
   - DataTable.tsx (TanStack Table wrapper with sorting, pagination, search)
   - StatCard.tsx (label, value, delta, icon, trend line sparkline using SVG)
   - AnimatedNumber.tsx (Framer Motion count-up)
   - PageHeader.tsx (title, subtitle, breadcrumbs, actions slot)
   - EmptyState.tsx (icon, title, description, action)
   - ConfirmDialog.tsx
   - Toast/sonner.tsx (saffron accent for success)

2. packages/ui/src/components/charts/:
   - RevenueChart.tsx (area chart, SVG-based, saffron gradient fill, no external chart lib)
   - BarChart.tsx (SVG-based, categorical)
   - Sparkline.tsx (mini SVG line chart for stat cards)

3. packages/shared/src/:
   - types/ (all TypeScript interfaces matching Prisma models)
   - constants/ (routes, plans, limits, feature flags)
   - utils/ (cn helper, formatCurrency, formatDate, formatRelativeTime)
   - validators/ (Zod schemas for all forms)
   - hooks/ (useDebounce, useLocalStorage, useOnlineStatus, useInterval)

ANIMATION SYSTEM (packages/ui/src/lib/animations.ts):
- fadeSlideUp: opacity 0->1, y 24->0, duration 0.5s, ease [0.22, 1, 0.36, 1]
- fadeSlideDown: opacity 0->1, y -12->0
- staggerContainer: children stagger 0.08s
- scaleIn: scale 0.95->1, opacity 0->1
- pageTransition: AnimatePresence wrapper for App Router navigation

ACCEPTANCE CRITERIA:
- [ ] `pnpm dev` starts web on :3000, control on :3001
- [ ] `pnpm db:push` creates all tables in PostgreSQL
- [ ] `pnpm db:seed` creates: 1 superadmin, 1 demo tenant with 2 branches, 1 owner
- [ ] All shared components render in Storybook (or a test page) without errors
- [ ] No hardcoded colors anywhere — all via Tailwind tokens
- [ ] tRPC router scaffolded in apps/control/src/server/api/ with health check endpoint
```

---

## SPRINT 1 — Landing Website (The $20K First Impression)

**Goal:** Build a marketing site so beautiful it sells the product before the demo call. Single-tenant static site with a blog, pricing, and demo request flow.

**Prompt for AI Agent:**

```
Build the landing website in apps/web/ using Next.js 14 App Router with static export (output: 'export').

PAGES TO BUILD:
1. / (Home) — Hero + Features + How It Works + Testimonials + Pricing + CTA + Footer
2. /features — Detailed feature grid with animated illustrations
3. /pricing — Plan comparison table with toggle (monthly/yearly)
4. /demo — Demo request form (saves to a simple API route that emails via Resend)
5. /blog — MDX blog with 3 starter posts about restaurant tech
6. /login — Redirects to apps/control auth

HOME PAGE SECTIONS (in order):

HERO SECTION:
- Full viewport height, centered content
- Background: #FFFCF7 with the radial saffron glow (CSS ::before pseudo-element)
- Floating orbs (blurred circles, pointer-events none, CSS animation float)
- Badge: "Now powering 200+ restaurants across MENA" with pulsing dot
- H1: "The POS that thinks like you do" — "thinks like you do" in saffron-500 with underline decoration
- Subtitle: "Zaeem POS unifies every order, table, and transaction into one intelligent system. Built for restaurants that refuse to settle."
- Two CTAs: "Start free trial" (saffron primary) + "Watch demo" (white secondary with play icon)
- Below CTAs: Live dashboard mock (the widget concept from the design doc) — a CSS-built mock UI showing stats, chart, sidebar
- Trust bar: "SOC 2 Compliant", "Offline-first", "Arabic & English", "iOS & Android" with small icons
- Animation: Staggered fadeSlideUp on load, 0.1s delay between elements

FEATURES SECTION:
- Background: white
- Section header: "Everything your restaurant needs" / "From order to insight, one seamless flow."
- 6 feature cards in 3x2 grid (responsive to 2x3 then 1x6):
  1. Lightning Orders — "Take orders in seconds, not minutes. Split bills, merge tables, handle modifiers without breaking flow."
  2. Real-time Sync — "Your desktop POS talks to your owner dashboard in real-time. See every order as it happens."
  3. Offline First — "Internet drops? No problem. Zaeem queues every transaction and syncs when you're back online."
  4. Smart Inventory — "Track stock levels, set auto-alerts, manage suppliers. Never run out of your bestseller."
  5. Multi-branch — "Own multiple locations? Monitor all branches from one dashboard. Compare performance, manage staff."
  6. Built-in Loyalty — "Turn first-time guests into regulars with points, rewards, and personalized offers."
- Each card: white bg, subtle border, rounded-2xl, icon in saffron-100 circle, hover lift + shadow-lg transition
- Scroll-triggered animation: cards fade in with stagger as they enter viewport (Framer Motion whileInView)

HOW IT WORKS:
- 3-step horizontal timeline (vertical on mobile)
- Step 1: "Install" — "Download Zaeem POS on any Windows PC. Setup takes 5 minutes."
- Step 2: "Configure" — "Add your menu, tables, staff, and tax rules. Import from Excel or build from scratch."
- Step 3: "Grow" — "Watch your dashboard fill with insights. Optimize your menu, cut waste, increase revenue."
- Connecting line between steps (saffron-200, animated dashoffset on scroll)
- Step numbers in saffron-500 circles

TESTIMONIALS:
- Horizontal scroll carousel (CSS scroll-snap, not a heavy lib)
- 4 testimonials with avatar, name, restaurant name, quote, star rating
- Cards with subtle warm background (#FFFBEB border, white fill)

PRICING TEASER:
- 3 plans: Starter ($29/mo), Professional ($79/mo), Enterprise (custom)
- Highlight Professional as "Most Popular" with saffron badge
- Feature checklist per plan
- CTA buttons link to /demo with plan pre-selected

FINAL CTA:
- Background: saffron gradient (subtle, from #FBBF24 to #F59E0B)
- Text: white, large heading "Ready to transform your restaurant?"
- Button: white bg, saffron text "Get started free"

FOOTER:
- 4 columns: Product, Company, Resources, Legal
- Newsletter signup (saffron focus ring)
- Social icons
- Bottom bar: "© 2026 Zaeem POS. All rights reserved."

NAVIGATION:
- Fixed top nav, transparent -> white with shadow on scroll (useScroll hook)
- Logo: "Zaeem" in bold saffron-600, "POS" in slate-900
- Links: Features, Pricing, Blog, Login
- Mobile: hamburger menu with slide-in drawer

TECHNICAL REQUIREMENTS:
- All images use Next.js Image component with placeholder="blur"
- Hero mock dashboard built entirely in CSS/SVG (no screenshots)
- Framer Motion for all scroll animations
- GSAP ScrollTrigger for the How It Works timeline line animation
- Meta tags, Open Graph, Twitter cards for every page
- Structured data (JSON-LD) for Organization and SoftwareApplication
- robots.txt and sitemap.xml
- 100/100 Lighthouse performance target (lazy load below-fold, optimize fonts)
- Arabic RTL support preparation (dir="rtl" toggle, all CSS logical properties)

ACCEPTANCE CRITERIA:
- [ ] All 6 pages render without errors
- [ ] Animations work smoothly on mid-range mobile (60fps)
- [ ] Demo form submits and sends email
- [ ] Lighthouse score > 90 for all categories
- [ ] No layout shift on load
- [ ] Responsive down to 320px width
```

---

## SPRINT 2 — Authentication & Authorization Infrastructure

**Goal:** Bulletproof auth that supports superadmins, owners, managers, and staff with role-based access control. Magic links + password + OAuth.

**Prompt for AI Agent:**

```
Build the complete auth system in apps/control/ using NextAuth.js v5 (Auth.js) with credentials, email magic links, and Google OAuth.

AUTH CONFIGURATION:
- providers: Credentials (email+password), Email (magic link via Resend), Google OAuth
- session strategy: JWT with RS256 (as already configured in zaeem-control)
- callbacks: signIn (check tenant status), session (inject role, tenantId, permissions), jwt (enrich token)
- pages: custom /auth/login, /auth/register, /auth/magic-link, /auth/error, /auth/verify-request

CUSTOM LOGIN PAGE (/auth/login):
- Split screen: left side has saffron gradient with product illustration (CSS/SVG), right side has form
- Form fields: email, password, "Remember me" checkbox
- "Sign in with Google" button (white, border, Google icon)
- "Send magic link" toggle (switches to email-only mode)
- "Forgot password?" link -> /auth/forgot-password
- "Don't have an account? Register" link
- Error states: inline messages in Arabic + English (detect browser lang)
- Animation: form fades in, input focus has saffron ring

REGISTRATION FLOW (/auth/register):
- Step 1: Account (name, email, password, confirm password)
- Step 2: Restaurant (restaurant name, number of branches, country, phone)
- Step 3: Plan selection (Starter/Pro/Enterprise cards, saffron highlight on selected)
- Step 4: Confirmation (summary + terms checkbox + "Create account")
- Progress indicator at top (4 steps, saffron fill)
- On submit: create User (role=OWNER), create Tenant, create first Branch, generate License (14-day trial), send welcome email
- Auto-login after registration, redirect to /owner onboarding

MIDDLEWARE & RBAC:
- middleware.ts: protect routes by role
  - /admin/* -> SUPERADMIN only
  - /owner/* -> OWNER, MANAGER
  - /staff/* -> STAFF and above
  - /api/trpc/* -> valid session required
- Permission matrix in packages/shared/src/constants/permissions.ts:
  - SUPERADMIN: everything
  - OWNER: manage own tenant, branches, staff, view reports
  - MANAGER: manage assigned branches, view branch reports
  - STAFF: view own orders, limited dashboard
- Helper: `withRole(handler, roles[])` HOC for API routes

FORGOT PASSWORD:
- /auth/forgot-password: email input, sends Resend email with reset token (JWT, 1hr expiry)
- /auth/reset-password: token validation, new password form

ONBOARDING (/owner/onboarding):
- Shown once after registration
- Welcome modal: "Welcome to Zaeem POS! Let's set up your first branch."
- Quick setup wizard: add menu categories, add 3 sample items, configure tax rate, invite staff member
- "Skip for now" option
- Mark onboarding complete in User metadata

SECURITY REQUIREMENTS:
- Passwords: min 8 chars, 1 uppercase, 1 number, 1 special char (Zod validation)
- Rate limiting: 5 login attempts per IP per 15min (Redis or in-memory for now)
- CSRF protection via NextAuth
- Secure cookie flags in production
- Audit log: every login, logout, password change, role change -> ActivityLog table

ACCEPTANCE CRITERIA:
- [ ] All auth flows work end-to-end (register -> login -> dashboard -> logout)
- [ ] Role-based route protection works (403 page for unauthorized)
- [ ] Magic links arrive and work
- [ ] Password reset flow complete
- [ ] Rate limiting triggers after 5 failed attempts
- [ ] Activity logs record all auth events
```

---

## SPRINT 3 — Super-Admin Panel (License & Tenant Management)

**Goal:** The command center for Zaeem the company. Manage licenses, tenants, billing, support tickets, and system health.

**Prompt for AI Agent:**

```
Build the Super-Admin dashboard at /admin in apps/control/. This is for Zaeem internal staff only (SUPERADMIN role).

LAYOUT:
- Sidebar navigation (collapsible, icons from Lucide):
  - Dashboard
  - Tenants
  - Licenses
  - Activity Logs
  - System Health
  - Settings
- Top bar: search, notification bell, admin avatar dropdown
- Breadcrumbs on every page

DASHBOARD (/admin):
- KPI cards row: Total Tenants, Active Licenses, MRR (Monthly Recurring Revenue), Churn Rate, Support Tickets Open
- Revenue chart: monthly recurring revenue over 12 months (SVG area chart, saffron gradient)
- Tenant growth chart: new tenants per month (bar chart)
- Recent activity feed: latest signups, license activations, plan upgrades (real-time via polling every 30s)
- Alerts panel: expiring licenses (next 7 days), suspended tenants, failed syncs
- Quick actions: "Generate License", "Impersonate Tenant", "Send Announcement"

TENANTS MANAGEMENT (/admin/tenants):
- DataTable with columns: Name, Plan, Status, Branches, Users, Created, Actions
- Filters: by plan, status, date range
- Search by name or slug
- Actions per row: View, Edit, Suspend/Activate, Impersonate (logs in as owner), Delete
- Bulk actions: suspend selected, export CSV
- Tenant detail drawer/sheet:
  - Overview tab: tenant info, owner details, usage stats (orders this month, revenue)
  - Branches tab: list of branches with online status, last ping
  - Users tab: staff list with roles
  - Billing tab: invoices, payment history, plan change history
  - Activity tab: full audit log for this tenant

LICENSES MANAGEMENT (/admin/licenses):
- Generate new license: form with plan, maxDevices, expiry date, notes
- License table: Key, Plan, Status, Tenant, Activated, Expires, Devices used/max, Actions
- Actions: Revoke, Extend, Transfer to different tenant
- Bulk generate: upload CSV or specify count -> generates batch of license keys
- License detail: full history of activations, device fingerprints, usage

ACTIVITY LOGS (/admin/activity):
- Filterable table: timestamp, user, action, tenant, IP, details
- Actions: login, logout, order_created, license_activated, tenant_suspended, etc.
- Export to CSV
- Real-time stream option (Server-Sent Events)

SYSTEM HEALTH (/admin/health):
- Cards: API response time, DB connection status, Redis status, POS sync queue depth
- Chart: API response times over last hour
- Error log: recent 500s with stack traces (sanitized)
- Background job status: sync workers, email queue, report generation

UI/UX REQUIREMENTS:
- All tables use the shared DataTable component with sorting, pagination (25/50/100), column visibility toggle
- All forms use React Hook Form + Zod
- All mutations use tRPC with optimistic updates
- Loading states: skeleton screens, not spinners
- Empty states: illustrated (SVG), actionable
- Confirm dialogs for destructive actions (delete, revoke, suspend)
- Toast notifications for all mutations (success = saffron, error = red)

ACCEPTANCE CRITERIA:
- [ ] Superadmin can CRUD tenants
- [ ] License generation creates valid keys
- [ ] Impersonate logs in as tenant owner without password
- [ ] Activity logs capture all admin actions
- [ ] System health page shows real metrics (not mock data)
- [ ] All tables sort, filter, paginate correctly
- [ ] Export to CSV works
```

---

## SPRINT 4 — Owner Dashboard (Branch Monitoring & Insights)

**Goal:** The crown jewel. Restaurant owners log in here to see their empire in real-time. Every branch, every order, every dirham.

**Prompt for AI Agent:**

```
Build the Owner Dashboard at /owner in apps/control/. This is the main product surface for restaurant owners.

LAYOUT:
- Sidebar (white, collapsible):
  - Logo: Zaeem (saffron) + restaurant name below
  - Nav: Overview, Live Orders, Branches, Reports, Staff, Inventory, Customers, Settings
  - Bottom: branch selector dropdown (if multi-branch), help button, user menu
- Top bar: branch selector (pill-shaped, saffron active), date range picker, notification bell, profile
- Main content area: white cards on #FFFCF7 canvas

OVERVIEW PAGE (/owner):
- Welcome header: "Good evening, [Name]" + current branch name + date
- KPI row (4 cards):
  1. Today's Revenue: $X,XXX (delta vs yesterday, sparkline)
  2. Orders Today: XX (delta, breakdown by type: dine-in/takeaway/delivery)
  3. Average Ticket: $XX (delta)
  4. Active Staff: X online (of Y total)
- Revenue chart: hourly breakdown for today (SVG area chart, saffron gradient fill, interactive hover tooltip)
- Top items: horizontal bar chart of best-selling items today
- Live activity feed: "New order #1234 - $45 - Table 5" (auto-scroll, newest top, saffron left border)
- Branch comparison (if multi-branch): mini cards per branch showing revenue and online status
- Quick actions: "View Reports", "Manage Menu", "Add Staff"

LIVE ORDERS PAGE (/owner/live-orders):
- Real-time order stream (WebSocket or SSE)
- Order cards: order number, type (color-coded badge), items list, total, table/delivery info, time elapsed
- Status pipeline: Pending -> Cooking -> Ready -> Served (Kanban-style columns)
- Drag-and-drop to change status (or click status buttons)
- Auto-refresh every 5 seconds with visual pulse on new orders
- Sound notification toggle (browser notification API)
- Filter by: branch, type, status, date
- Order detail modal: full receipt, customer info, payment status, void option

BRANCHES PAGE (/owner/branches):
- Grid of branch cards:
  - Branch name, address, phone
  - Online status (green pulse dot if online, red if last ping > 5min)
  - Today's stats: revenue, orders, avg ticket
  - Device info: POS version, last sync
  - Actions: View details, Edit, Sync now, Restart POS (sends command via WebSocket)
- Branch detail page:
  - Performance tab: revenue over time, order volume, peak hours
  - Staff tab: who's clocked in, performance metrics
  - Settings tab: tax config, receipt template, printer settings
  - Devices tab: registered POS devices, license usage

REPORTS PAGE (/owner/reports):
- Date range picker (preset: Today, Yesterday, Last 7 Days, Last 30 Days, This Month, Custom)
- Report types:
  - Sales Summary: revenue, orders, avg ticket, tax collected, discounts given
  - Item Performance: sales by item, category, modifier
  - Staff Performance: orders taken, voids, avg ticket per staff
  - Payment Methods: cash vs card vs other breakdown (donut chart)
  - Hourly Analysis: heatmap of order volume by hour/day
- All reports exportable to PDF (using jsPDF + autoTable) and Excel (using xlsx)
- Save report as favorite
- Schedule report: email me this report every Monday at 9 AM

CUSTOMERS PAGE (/owner/customers):
- Customer database: name, phone, total visits, total spent, last visit, loyalty points
- Customer detail: visit history, favorite items, notes
- Loyalty program settings: points per $ spent, redemption rules, tiers
- SMS marketing: send promotional SMS to segments (high spenders, inactive, etc.)

SETTINGS PAGE (/owner/settings):
- Profile: name, email, password change
- Restaurant: name, logo upload, currency, timezone, language (Arabic/English toggle)
- Tax: default tax rate, tax-inclusive vs exclusive, multiple tax rules
- Receipt: header text, footer text, show logo, printer selection
- Notifications: email alerts for low stock, daily summary, license expiry
- Billing: current plan, usage, upgrade/downgrade, payment method, invoices
- Integrations: connect to food delivery platforms (placeholder for future)

REAL-TIME ARCHITECTURE:
- Use Socket.io for live order updates
- Owner connects to namespace `/owner/{tenantId}`
- POS desktop app emits events: order_created, order_updated, order_completed
- Dashboard listens and updates UI in real-time
- Fallback: polling every 10 seconds if WebSocket disconnected

MOBILE RESPONSIVE:
- Sidebar becomes bottom nav on mobile
- KPI cards stack vertically
- Charts simplify to sparklines on small screens
- Live orders become a scrollable list (no Kanban)

ACCEPTANCE CRITERIA:
- [ ] Overview shows real data from database (not mocks)
- [ ] Live orders update within 5 seconds of POS order
- [ ] Branch online/offline status accurate
- [ ] All reports generate correctly with date filtering
- [ ] PDF/Excel export works
- [ ] Settings save and reflect immediately
- [ ] Mobile layout usable on iPhone SE
```

---

## SPRINT 5 — POS-to-Cloud Sync Bridge

**Goal:** The desktop POS app syncs orders, inventory, and config with the cloud dashboard. Offline-first queue, conflict resolution, secure device pairing.

**Prompt for AI Agent:**

```
Build the sync bridge between apps/zaeem-pos (Tauri desktop) and apps/control (cloud dashboard).

This sprint modifies BOTH apps. Be careful with the existing POS code.

PART A: Cloud API (apps/control/)

Create tRPC routers and REST endpoints for POS sync:

1. Device Registration:
   - POST /api/pos/register
   - Body: { licenseKey, deviceName, deviceFingerprint (hardware ID), version }
   - Validates license (not expired, not max devices exceeded)
   - Returns: { deviceId, authToken (long-lived JWT), tenantId, branchId, syncEndpoint }
   - Stores device in new Device table: id, tenantId, branchId, name, fingerprint, version, lastSeen, status

2. Order Sync:
   - POST /api/pos/sync/orders
   - Headers: Authorization: Bearer {deviceToken}
   - Body: { orders: [{ posOrderId, type, status, items, totalCents, taxCents, customerName, customerPhone, deliveryAddress, tableId, createdAt }] }
   - Upserts orders (by posOrderId + branchId)
   - Returns: { synced: number, conflicts: [] }
   - Emits Socket.io event to owner dashboard

3. Config Sync:
   - GET /api/pos/config
   - Returns: { taxConfig, menuVersion, receiptSettings, featuresEnabled }
   - POS polls this on startup and every 5 minutes

4. Heartbeat:
   - POST /api/pos/heartbeat
   - Updates device.lastSeen, branch.isOnline = true
   - If no heartbeat for 5 minutes, branch marked offline (cron job or TTL)

5. Command Channel:
   - GET /api/pos/commands?since={timestamp}
   - Returns pending commands: { type: "SYNC_NOW" | "UPDATE_CONFIG" | "RESTART" | "ANNOUNCE", payload }
   - POS polls every 30 seconds
   - Admin/Owner can queue commands from dashboard

PART B: POS Sync Client (apps/zaeem-pos/src/lib/sync/)

Create a sync engine that integrates with existing stores:

1. SyncEngine class:
   - init(): register device on first run, load auth token
   - start(): begin periodic sync loops
   - queueOrder(order): add to local SQLite queue table
   - flushQueue(): send queued orders to cloud
   - syncConfig(): fetch latest config from cloud
   - heartbeat(): ping cloud every 60 seconds
   - handleCommand(): process commands from cloud

2. SQLite Schema additions (in Rust backend):
   - sync_queue: id, table_name, record_id, action (CREATE/UPDATE/DELETE), payload (JSON), retry_count, created_at, synced_at
   - device_info: key-value store for auth token, deviceId, lastSyncAt

3. Integration points:
   - After order creation in cartStore: also call syncEngine.queueOrder()
   - On app startup: syncEngine.init() -> syncConfig() -> flushQueue()
   - Background sync: every 60 seconds if online
   - On network status change (online event): immediate flush

4. Offline handling:
   - If network request fails: increment retry_count, exponential backoff (max 5 retries)
   - Show sync status indicator in POS UI (top bar): green dot = synced, yellow = syncing, red = offline with N pending
   - Click indicator shows sync details modal: queue count, last sync time, errors

5. Conflict resolution:
   - Last-write-wins for orders (POS is source of truth for its own orders)
   - If cloud rejects (duplicate posOrderId): mark as synced locally
   - Config: cloud always wins

PART C: Dashboard Integration

1. Branch status card shows: online/offline, last sync time, pending queue count, POS version
2. "Force Sync" button sends SYNC_NOW command to POS
3. "Send Announcement" sends ANNOUNCE command (shows modal in POS)
4. Device management page: list registered devices, revoke access, view sync history

SECURITY:
- Device tokens are long-lived (90 days) but refreshable
- All POS API endpoints require valid device token
- Rate limit: 100 requests/min per device
- Validate license on every sync call

ACCEPTANCE CRITERIA:
- [ ] POS registers device on first run with license key
- [ ] Order created in POS appears in owner dashboard within 10 seconds
- [ ] POS works fully offline, queues orders, syncs when back online
- [ ] Branch online/offline status accurate to within 2 minutes
- [ ] Admin can send command to POS from dashboard
- [ ] Device token refreshes automatically
- [ ] Sync status visible in POS UI
```

---

## SPRINT 6 — Real-time Features & Notifications

**Goal:** Make the dashboard feel alive. WebSockets, push notifications, activity streams, and alerts.

**Prompt for AI Agent:**

```
Implement real-time infrastructure across the entire stack.

INFRASTRUCTURE:
- Socket.io server integrated with Next.js (custom server or API route adapter)
- Redis adapter for Socket.io (enables multi-instance scaling)
- Namespaces: /owner/{tenantId}, /admin, /pos/{deviceId}
- Rooms: branch-{branchId}, tenant-{tenantId}

REAL-TIME FEATURES:

1. Live Order Stream:
   - When POS creates order -> POST to API -> API emits to Socket.io room branch-{branchId}
   - Owner dashboard listens on /owner/{tenantId}, filters by selected branches
   - New order appears with animation (slide in from top, saffron left border flash)
   - Browser notification if tab not focused (Notification API, requires user permission)
   - Sound notification (subtle chime, toggleable in settings)

2. Branch Status Updates:
   - POS heartbeat updates branch.isOnline
   - If branch goes offline: emit to owner dashboard, show toast warning
   - If branch comes back online: emit, show success toast
   - Dashboard header shows online branch count with live pulse dot

3. Activity Stream:
   - Global activity feed component used in both admin and owner dashboards
   - Events: order_created, order_completed, staff_login, inventory_alert, license_expiry_warning
   - Real-time append (newest top)
   - Filter by event type, branch, date
   - Click event to navigate to relevant page

4. Push Notifications (Web Push):
   - VAPID keys generated (already in env from zaeem-control setup)
   - Service worker in apps/control/public/sw.js
   - Subscription stored per user in DB (PushSubscription table)
   - Trigger notifications for:
     - New order (if owner not on dashboard)
     - Branch offline > 5 minutes
     - Daily revenue summary (scheduled, 11 PM)
     - Low stock alert
     - License expiring (7, 3, 1 days before)
   - Click notification opens relevant page

5. Announcements:
   - Admin can broadcast announcement to all tenants or specific tenant
   - Announcement appears as banner in owner dashboard (dismissible)
   - Can also send to POS (appears as modal on next command poll)
   - Announcement table: id, title, message, target (all/specific tenant), priority, startAt, endAt, dismissedBy []

6. Live Collaboration (future-proofing):
   - If multiple managers view same branch dashboard, show "X managers viewing" indicator
   - Cursor presence (optional, complex — placeholder for now)

NOTIFICATION CENTER:
- Bell icon in top bar with unread count badge (saffron background)
- Dropdown panel: grouped by date, unread highlighted
- Mark all as read, mark individual as read
- Settings: which events trigger notifications, email vs push vs in-app

ALERTS SYSTEM:
- Configurable alert rules per tenant:
  - Revenue drops > X% vs yesterday
  - Order count < Y at Z hour (slow business alert)
  - Branch offline > N minutes
  - Inventory item below threshold
  - Staff not clocked in by opening time
- Alerts appear in notification center + email
- Alert history page

ACCEPTANCE CRITERIA:
- [ ] New order from POS appears in owner dashboard in < 3 seconds
- [ ] Browser notification fires when order created and tab not focused
- [ ] Branch offline alert fires within 5 minutes of missed heartbeat
- [ ] Push notifications work on mobile Chrome/Safari
- [ ] Notification center shows all events, mark-as-read works
- [ ] Admin announcement appears in owner dashboard and POS
- [ ] Alert rules configurable and firing correctly
```

---

## SPRINT 7 — Polish, Performance, SEO, PWA

**Goal:** The final 10% that makes it feel like $20K. Animations, performance, accessibility, PWA, and every micro-interaction perfected.

**Prompt for AI Agent:**

```
This is the polish sprint. Every pixel, every transition, every millisecond counts.

ANIMATIONS & MICRO-INTERACTIONS:
1. Page transitions:
   - AnimatePresence wrapper around all route changes in apps/control
   - Fade + slight slide up (y: 10 -> 0) on enter
   - Duration: 200ms, ease: [0.22, 1, 0.36, 1]

2. Loading states:
   - Skeleton screens for all data-dependent components (never generic spinners)
   - Skeleton: shimmer animation (saffron-tinted gray gradient sweep)
   - Button loading: spinner inside button, text fades to 0.5 opacity
   - Card loading: pulse animation on gray background

3. Hover states:
   - Cards: translateY(-2px) + shadow-lg, 200ms ease-out
   - Table rows: bg-hover (#FFF7ED), 150ms
   - Buttons: see color-palette.md specs exactly
   - Links: saffron underline slides in from left

4. Success states:
   - Form submission: button turns green briefly, checkmark icon, then back to normal
   - Data save: toast slides in from top-right, auto-dismiss 4s
   - New order: card slides in with saffron left border flash

5. Number animations:
   - All KPI values animate on load (count up from 0)
   - Revenue numbers: 1.5s duration, easeOutExpo
   - Delta percentages: animate with + or - prefix

6. Scroll animations:
   - IntersectionObserver + Framer Motion for all below-fold content
   - Stagger children: 0.08s delay between items
   - Parallax on hero section (subtle, 0.1x speed)

PERFORMANCE:
1. Next.js optimizations:
   - Image component with priority on hero images
   - next/font for Inter (preload, subset Latin + Arabic)
   - Dynamic imports for heavy components (charts, modals, PDF export)
   - Route prefetching for all nav links
   - Streaming SSR for dashboard (skeleton while data loads)

2. Bundle optimization:
   - Tree-shake unused Lucide icons (import individually)
   - Code-split tRPC routers
   - Lazy load Socket.io client (only on dashboard pages)

3. Database:
   - Add indexes: Order.branchId+createdAt, User.tenantId+role, Branch.tenantId
   - Connection pooling (PgBouncer if needed)
   - Query optimization: no N+1 (use Prisma include wisely)

4. Caching:
   - Redis cache for: tenant config, menu data, reports (cache 5min)
   - Next.js ISR for landing pages (revalidate 1 hour)
   - SWR/React Query for client-side caching with stale-while-revalidate

ACCESSIBILITY (A11Y):
1. WCAG 2.1 AA compliance:
   - All interactive elements keyboard accessible
   - Focus visible: saffron-400 ring, 2px offset
   - Color contrast: all text meets 4.5:1 ratio (verify with tool)
   - Screen reader labels on all icons, buttons, form fields
   - ARIA live regions for notifications and live order updates

2. Reduced motion:
   - Respect prefers-reduced-motion: disable parallax, reduce transition durations
   - Keep functionality intact without animations

3. RTL Support:
   - All CSS uses logical properties (margin-inline-start, padding-inline-end)
   - dir="rtl" toggle in settings
   - Arabic translations for all UI strings (use next-intl)
   - Date/number formatting per locale

PWA (apps/control/):
1. manifest.json: name, icons, theme_color #FFFCF7, background_color #FFFFFF
2. Service worker: workbox or custom sw.js
   - Cache static assets
   - Offline page fallback
   - Background sync for form submissions
3. Install prompt: custom "Add to Home Screen" banner
4. Standalone mode: hide browser chrome, feel like native app

SEO:
1. Landing site (apps/web/):
   - Meta titles/descriptions for every page
   - Open Graph images (1200x630, saffron branded)
   - Twitter cards
   - Structured data: Organization, SoftwareApplication, FAQPage
   - robots.txt, sitemap.xml (dynamic, includes blog posts)
   - Canonical URLs
   - Core Web Vitals: LCP < 2.5s, FID < 100ms, CLS < 0.1

2. Dashboard (apps/control/):
   - robots.txt: disallow /admin, /owner, /api
   - Meta: noindex on auth pages

ERROR HANDLING:
1. Custom error pages:
   - 404: illustrated, search bar, popular links
   - 500: "Something went wrong", auto-report, retry button
   - 403: "You don't have permission", contact admin link
   - Offline: "You're offline", cached data display if available

2. Error boundaries:
   - React Error Boundary around every major section
   - Fallback UI: card with error message, retry button, contact support
   - Log errors to Sentry (or console for now)

TESTING:
1. E2E tests (Playwright):
   - Auth flow: register -> login -> dashboard -> logout
   - Owner: view overview, place test order via API, see it in live orders
   - Admin: generate license, create tenant, verify in list
   - Critical paths only (don't over-test)

2. Unit tests (Vitest):
   - Utility functions: formatCurrency, formatDate, validators
   - Component tests: Button, Input, Badge render correctly

3. Visual regression (optional): Chromatic or Percy for shared components

MONITORING:
1. Health check endpoint: /api/health (DB, Redis, external services)
2. Logging: structured JSON logs (Winston or Pino)
3. Metrics: request duration, error rate, active WebSocket connections (Prometheus format)

ACCEPTANCE CRITERIA:
- [ ] Lighthouse score > 95 on all pages (landing > 98)
- [ ] No layout shift (CLS < 0.05)
- [ ] All animations run at 60fps
- [ ] Keyboard navigation works end-to-end
- [ ] Screen reader can complete core tasks
- [ ] PWA installable on Android and iOS
- [ ] RTL layout correct for all pages
- [ ] E2E tests pass
- [ ] Error boundaries catch and display all errors gracefully
```

---

## APPENDIX A — Complete File Structure (Post-Sprint 7)

```
zaeem-ecosystem/
├── apps/
│   ├── web/                          # Landing site (Next.js, static)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── page.tsx          # Home
│   │   │   │   ├── features/
│   │   │   │   ├── pricing/
│   │   │   │   ├── demo/
│   │   │   │   ├── blog/
│   │   │   │   └── layout.tsx
│   │   │   ├── components/
│   │   │   │   ├── hero/
│   │   │   │   ├── features/
│   │   │   │   ├── testimonials/
│   │   │   │   ├── pricing/
│   │   │   │   └── navigation/
│   │   │   └── lib/
│   │   └── public/
│   ├── control/                      # Admin + Owner (Next.js, fullstack)
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (auth)/
│   │   │   │   │   ├── auth/login/
│   │   │   │   │   ├── auth/register/
│   │   │   │   │   └── auth/forgot-password/
│   │   │   │   ├── (dashboard)/
│   │   │   │   │   ├── admin/
│   │   │   │   │   │   ├── page.tsx
│   │   │   │   │   │   ├── tenants/
│   │   │   │   │   │   ├── licenses/
│   │   │   │   │   │   ├── activity/
│   │   │   │   │   │   └── health/
│   │   │   │   │   ├── owner/
│   │   │   │   │   │   ├── page.tsx
│   │   │   │   │   │   ├── live-orders/
│   │   │   │   │   │   ├── branches/
│   │   │   │   │   │   ├── reports/
│   │   │   │   │   │   ├── customers/
│   │   │   │   │   │   └── settings/
│   │   │   │   │   └── layout.tsx
│   │   │   │   ├── api/
│   │   │   │   │   ├── auth/[...nextauth]/
│   │   │   │   │   ├── pos/
│   │   │   │   │   │   ├── register/
│   │   │   │   │   │   ├── sync/
│   │   │   │   │   │   ├── heartbeat/
│   │   │   │   │   │   └── commands/
│   │   │   │   │   ├── trpc/[trpc]/
│   │   │   │   │   └── health/
│   │   │   │   └── layout.tsx
│   │   │   ├── components/
│   │   │   │   ├── layout/
│   │   │   │   │   ├── sidebar.tsx
│   │   │   │   │   ├── topbar.tsx
│   │   │   │   │   └── breadcrumbs.tsx
│   │   │   │   ├── dashboard/
│   │   │   │   │   ├── kpi-cards.tsx
│   │   │   │   │   ├── revenue-chart.tsx
│   │   │   │   │   ├── activity-feed.tsx
│   │   │   │   │   └── branch-comparison.tsx
│   │   │   │   ├── orders/
│   │   │   │   │   ├── order-card.tsx
│   │   │   │   │   ├── kanban-board.tsx
│   │   │   │   │   └── order-detail.tsx
│   │   │   │   └── notifications/
│   │   │   │       ├── bell-button.tsx
│   │   │   │       └── notification-panel.tsx
│   │   │   ├── server/
│   │   │   │   ├── api/
│   │   │   │   │   ├── routers/
│   │   │   │   │   │   ├── tenant.ts
│   │   │   │   │   │   ├── license.ts
│   │   │   │   │   │   ├── order.ts
│   │   │   │   │   │   ├── branch.ts
│   │   │   │   │   │   ├── user.ts
│   │   │   │   │   │   ├── report.ts
│   │   │   │   │   │   └── activity.ts
│   │   │   │   │   └── trpc.ts
│   │   │   │   ├── auth/
│   │   │   │   │   └── config.ts
│   │   │   │   └── db.ts
│   │   │   └── hooks/
│   │   │       ├── use-realtime.ts
│   │   │       ├── use-auth.ts
│   │   │       └── use-notifications.ts
│   │   └── public/
│   │       ├── sw.js
│   │       └── manifest.json
│   └── pos/                          # Existing Tauri app
│       └── src/
│           └── lib/
│               └── sync/             # NEW: sync engine
│                   ├── engine.ts
│                   ├── queue.ts
│                   ├── api-client.ts
│                   └── types.ts
├── packages/
│   ├── ui/                           # Shared components
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── primitives/
│   │   │   │   ├── charts/
│   │   │   │   └── data-display/
│   │   │   └── lib/
│   │   │       └── animations.ts
│   │   └── tailwind.config.ts
│   ├── shared/                       # Types, utils, validators, hooks
│   │   └── src/
│   │       ├── types/
│   │       ├── constants/
│   │       ├── utils/
│   │       ├── validators/
│   │       └── hooks/
│   └── db/                           # Prisma schema + client
│       └── prisma/
│           └── schema.prisma
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## APPENDIX B — API Contract Summary

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/pos/register` | POST | License key | Register POS device |
| `/api/pos/sync/orders` | POST | Device token | Sync orders from POS |
| `/api/pos/config` | GET | Device token | Get tenant config |
| `/api/pos/heartbeat` | POST | Device token | POS heartbeat |
| `/api/pos/commands` | GET | Device token | Poll for commands |
| `/api/trpc/tenant.*` | tRPC | Session | Tenant CRUD |
| `/api/trpc/license.*` | tRPC | Session | License management |
| `/api/trpc/order.*` | tRPC | Session | Order queries |
| `/api/trpc/branch.*` | tRPC | Session | Branch management |
| `/api/trpc/report.*` | tRPC | Session | Report generation |
| `/api/trpc/activity.*` | tRPC | Session | Activity logs |
| `/api/health` | GET | None | System health check |

---

## APPENDIX C — Color Token Quick Reference

Use these EXACT values everywhere. No exceptions.

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-canvas` | `#FFFCF7` | App background |
| `--bg-card` | `#FFFFFF` | Cards, panels, modals |
| `--saffron-500` | `#F59E0B` | ONE primary button per screen |
| `--saffron-50` | `#FFFBEB` | Active nav, hover tint, focus ring |
| `--text-primary` | `#0F172A` | Headings, key data |
| `--text-secondary` | `#475569` | Body text |
| `--text-muted` | `#94A3B8` | Captions, placeholders |
| `--slate-200` | `#E2E8F0` | All borders |
| `--success` | `#16A34A` | Paid, completed |
| `--danger` | `#DC2626` | Cancelled, error |

---

*End of Sprint Prompts. Feed these to your AI agent one at a time. Do not skip Sprint 0.*
