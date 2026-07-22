# Design Bible — زعيم نقاط البيع (POS + CRM + ERP)

> **Scope:** Purely visual. Zero logic changes. Zero structural changes. Zero API changes.  
> **Goal:** Elevate the entire application to a premium, cohesive visual system using saffron as the primary accent.  
> **Constraint:** Every change below is CSS/design-token only. Do not modify component behavior, state logic, routing, data fetching, or Rust/Tauri bindings.

---

## 1. Design Philosophy

- **Invisible UI:** The interface should feel like it disappears. Content is king. Chrome is minimal.
- **Warm Premium:** Saffron is the soul — used sparingly, intentionally, never sprayed everywhere.
- **Consistent Rhythm:** Every spacing value, radius, and shadow follows a strict scale. No arbitrary values.
- **RTL-First:** The application is Arabic (RTL). All directional properties must respect `dir="rtl"`.

---

## 2. Color System

### 2.1 Primary Palette — Saffron

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-saffron-50` | `#FFFBEB` | Lightest tint backgrounds, hover states |
| `--color-saffron-100` | `#FEF3C7` | Subtle highlights, tag backgrounds |
| `--color-saffron-200` | `#FDE68A` | Secondary accents, focus ring tints |
| `--color-saffron-300` | `#FCD34D` | Decorative elements, chart accents |
| `--color-saffron-400` | `#FBBF24` | Icons on saffron backgrounds |
| `--color-saffron-500` | `#F59E0B` | **Primary saffron** — CTAs, active states |
| `--color-saffron-600` | `#D97706` | Primary hover, pressed states |
| `--color-saffron-700` | `#B45309` | Dark saffron — emphasis text on light bg |
| `--color-saffron-800` | `#92400E` | Deep saffron — dark mode accents |
| `--color-saffron-900` | `#78350F` | Darkest saffron — text on saffron bg |

### 2.2 Neutral Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-white` | `#FFFFFF` | Card backgrounds, sidebar, inputs |
| `--color-warm-50` | `#FAFAF9` | Main canvas background (replaces gray-50) |
| `--color-warm-100` | `#F5F5F4` | Table header bg, subtle separators |
| `--color-warm-200` | `#E7E5E4` | Borders, dividers, disabled outlines |
| `--color-warm-300` | `#D6D3D1` | Secondary borders, placeholder text |
| `--color-warm-400` | `#A8A29E` | Muted labels, captions, metadata |
| `--color-warm-500` | `#78716C` | Secondary text, inactive nav items |
| `--color-warm-600` | `#57534E` | Body text, table content |
| `--color-warm-700` | `#44403C` | Headings, primary body text |
| `--color-warm-800` | `#292524` | Strong headings, sidebar active text |
| `--color-warm-900` | `#1C1917` | **Primary text** — headings, key values |

### 2.3 Semantic Colors (Status)

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-success` | `#16A34A` | Completed, paid, available |
| `--color-success-bg` | `color-mix(in srgb, #16A34A 10%, transparent)` | Success tag backgrounds |
| `--color-warning` | `#D97706` | Pending, cooking, processing |
| `--color-warning-bg` | `color-mix(in srgb, #D97706 10%, transparent)` | Warning tag backgrounds |
| `--color-danger` | `#DC2626` | Cancelled, error, low stock |
| `--color-danger-bg` | `color-mix(in srgb, #DC2626 10%, transparent)` | Danger tag backgrounds |
| `--color-info` | `#2563EB` | Informational, links |
| `--color-info-bg` | `color-mix(in srgb, #2563EB 10%, transparent)` | Info tag backgrounds |

### 2.4 Color Usage Rules

1. **Saffron is sacred.** Use `--color-saffron-500` ONLY for:
   - Primary action buttons (1 per screen max)
   - Active nav item indicator
   - Current tab underline / pill
   - Key metric trend arrows (positive)
   - Selected state in single-select lists

2. **Never use saffron for:**
   - Body text
   - Secondary buttons (use `--color-warm-800` or outline style)
   - Borders (use `--color-warm-200`)
   - Background fills of large areas
   - Icons in navigation (use `--color-warm-500` inactive, `--color-warm-900` active)

3. **Background hierarchy (light mode):**
   - App canvas: `--color-warm-50` (#FAFAF9)
   - Sidebar: `--color-white` (#FFFFFF)
   - Cards / panels: `--color-white` (#FFFFFF)
   - Table rows: `--color-white` (odd), `--color-warm-50` (even) — OPTIONAL zebra
   - Inputs: `--color-white` (#FFFFFF)

---

## 3. Typography

### 3.1 Font Family

```css
:root {
  --font-sans: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
}
```

**Action:** Add Inter font to your Tauri app. Load via `@fontsource/inter` npm package or Google Fonts (if webview has internet). For offline, bundle the font files.

### 3.2 Type Scale

| Token | Size | Weight | Line-Height | Letter-Spacing | Usage |
|-------|------|--------|-------------|----------------|-------|
| `text-hero` | 36px | 500 | 1.1 | -0.02em | Dashboard KPI values |
| `text-h1` | 24px | 500 | 1.2 | -0.01em | Page titles |
| `text-h2` | 20px | 500 | 1.3 | 0 | Section headings |
| `text-h3` | 17px | 500 | 1.4 | 0 | Card titles, sub-sections |
| `text-body` | 14px | 400 | 1.5 | 0 | Body text, table cells |
| `text-body-em` | 14px | 500 | 1.5 | 0 | Emphasized body, labels |
| `text-caption` | 12px | 400 | 1.4 | 0.01em | Metadata, timestamps |
| `text-caption-em` | 12px | 500 | 1.4 | 0.01em | Column headers, badges |
| `text-tiny` | 11px | 500 | 1.3 | 0.02em | Tags, status pills, trends |

### 3.3 Typography Rules

- **Two weights only:** 400 (regular) and 500 (medium). No 600, 700, or bold.
- **Numeric values** (prices, quantities, IDs) must use `font-variant-numeric: tabular-nums;` for alignment.
- **RTL:** Ensure `text-align` respects direction. Use logical properties: `text-align: start` / `end` instead of `left` / `right`.
- **Color hierarchy:**
  - `--color-warm-900` for headings and primary values
  - `--color-warm-600` for body text
  - `--color-warm-400` for captions, placeholders, disabled

---

## 4. Spacing System

All spacing must snap to this scale. No exceptions.

| Token | Value | Usage |
|-------|-------|-------|
| `space-1` | 4px | Tight internal padding, icon gaps |
| `space-2` | 8px | Button padding Y, small gaps |
| `space-3` | 12px | Card internal padding, table cell padding |
| `space-4` | 16px | Standard gap, card padding |
| `space-5` | 20px | Section padding |
| `space-6` | 24px | Page padding, large gaps |
| `space-8` | 32px | Major section separation |
| `space-10` | 40px | Hero spacing |

### 4.1 Spacing Rules

- **Page padding:** `24px` (space-6) on all sides of the main content area.
- **Card padding:** `16px` (space-4) internal.
- **Card gap:** `16px` (space-4) between cards.
- **Table row height:** Minimum `56px`. Padding `12px 16px`.
- **Sidebar item padding:** `10px 16px`.
- **Button padding:** `10px 20px` (primary), `8px 16px` (small).
- **Input padding:** `10px 14px`.
- **Section gap:** `24px` (space-6) between major sections.

---

## 5. Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `radius-sm` | 6px | Small buttons, tags, badges |
| `radius-md` | 8px | Buttons, inputs, sidebar items |
| `radius-lg` | 12px | Cards, panels, modals |
| `radius-xl` | 16px | Large cards, feature panels |
| `radius-full` | 9999px | Pills, avatars, circular buttons |

### 5.1 Radius Rules

- **Nested radius:** Inner element radius = outer radius - padding.
  - Example: A `radius-lg` (12px) card with `16px` padding holds `radius-sm` (6px) buttons.
- **Never** let an inner element be rounder than its container.
- **Sidebar:** `radius-md` (8px) for active/hover item backgrounds.
- **Tables:** `radius-lg` (12px) on the table container. Rows have no individual radius.
- **Product cards (POS):** `radius-lg` (12px) or `radius-xl` (16px).

---

## 6. Shadows & Elevation

| Token | Value | Usage |
|-------|-------|-------|
| `shadow-none` | none | Flat elements on canvas |
| `shadow-sm` | `0 1px 2px rgba(0,0,0,0.04)` | Subtle lift — hovered rows |
| `shadow-md` | `0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` | **Default card shadow** |
| `shadow-lg` | `0 4px 12px rgba(0,0,0,0.08)` | Dropdowns, popovers, modals |
| `shadow-xl` | `0 8px 24px rgba(0,0,0,0.10)` | Modal overlay, date picker |

### 6.1 Shadow Rules

- **Cards:** Use `shadow-md` by default. On hover, transition to `shadow-lg` with `transform: translateY(-1px)`.
- **No shadow on:** Sidebar, table containers, page canvas, input fields (use border instead).
- **Dropdowns / popovers:** `shadow-lg` + `radius-lg`.
- **Modals:** `shadow-xl` + overlay `rgba(0,0,0,0.40)`.
- **Transition:** All shadow changes animate over `150ms ease-out`.

---

## 7. Component Specifications

### 7.1 Buttons

#### Primary Button (Saffron)
```css
.btn-primary {
  background: var(--color-saffron-500);
  color: #FFFFFF;
  padding: 10px 20px;
  border-radius: var(--radius-md); /* 8px */
  font-size: 14px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: background 150ms ease-out, box-shadow 150ms ease-out;
}
.btn-primary:hover {
  background: var(--color-saffron-600);
  box-shadow: var(--shadow-sm);
}
.btn-primary:active {
  background: var(--color-saffron-700);
  transform: scale(0.98);
}
.btn-primary:disabled {
  background: var(--color-warm-200);
  color: var(--color-warm-400);
  cursor: not-allowed;
}
```

#### Secondary Button (Outline)
```css
.btn-secondary {
  background: transparent;
  color: var(--color-warm-700);
  padding: 10px 20px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  border: 1px solid var(--color-warm-200);
  cursor: pointer;
  transition: all 150ms ease-out;
}
.btn-secondary:hover {
  background: var(--color-warm-50);
  border-color: var(--color-warm-300);
}
```

#### Ghost Button
```css
.btn-ghost {
  background: transparent;
  color: var(--color-warm-600);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  border: none;
  cursor: pointer;
}
.btn-ghost:hover {
  background: var(--color-warm-100);
  color: var(--color-warm-800);
}
```

#### Icon Button (Add to cart, actions)
```css
.btn-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  background: var(--color-saffron-500);
  color: #FFFFFF;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  cursor: pointer;
  transition: background 150ms ease-out;
}
.btn-icon:hover {
  background: var(--color-saffron-600);
}
```

**Rule:** Only ONE primary (saffron) button per screen/section. All other actions are secondary or ghost.

---

### 7.2 Cards

```css
.card {
  background: var(--color-white);
  border-radius: var(--radius-lg); /* 12px */
  border: 1px solid var(--color-warm-200);
  box-shadow: var(--shadow-md);
  padding: var(--space-4); /* 16px */
  transition: box-shadow 150ms ease-out, transform 150ms ease-out;
}
.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-1px);
}
```

**Variants:**
- **KPI card:** No border, no shadow. Just `background: white` on `warm-50` canvas. Large value (36px), tiny label (11px) above.
- **Product card (POS):** `radius-xl` (16px), image on top, content below. Add button at bottom.
- **Table container card:** `radius-lg`, no internal padding. Table fills the card.

---

### 7.3 Tables

```css
.table-container {
  background: var(--color-white);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-warm-200);
  overflow: hidden;
}
.table {
  width: 100%;
  border-collapse: collapse;
}
.table th {
  background: var(--color-warm-50);
  color: var(--color-warm-400);
  font-size: 11px;
  font-weight: 500;
  text-transform: none; /* NEVER ALL CAPS */
  padding: 12px 16px;
  text-align: start;
  border-bottom: 1px solid var(--color-warm-200);
}
.table td {
  padding: 14px 16px;
  font-size: 14px;
  color: var(--color-warm-600);
  border-bottom: 1px solid var(--color-warm-100);
}
.table tr:last-child td {
  border-bottom: none;
}
.table tr:hover td {
  background: var(--color-warm-50);
}
```

**Rules:**
- NO vertical borders. Only horizontal dividers.
- Row height minimum 56px.
- Header row is distinct (warm-50 bg, muted text).
- Action buttons in rows are hover-revealed (opacity 0 → 1 on row hover).

---

### 7.4 Inputs & Forms

```css
.input {
  background: var(--color-white);
  border: 1px solid var(--color-warm-200);
  border-radius: var(--radius-md); /* 8px */
  padding: 10px 14px;
  font-size: 14px;
  color: var(--color-warm-900);
  transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
}
.input::placeholder {
  color: var(--color-warm-400);
}
.input:focus {
  outline: none;
  border-color: var(--color-saffron-400);
  box-shadow: 0 0 0 3px var(--color-saffron-100);
}
.input:disabled {
  background: var(--color-warm-50);
  color: var(--color-warm-400);
}
.input-error {
  border-color: var(--color-danger);
}
.input-error:focus {
  box-shadow: 0 0 0 3px var(--color-danger-bg);
}
```

**Search input (global):**
```css
.search-input {
  background: var(--color-white);
  border: 1px solid var(--color-warm-200);
  border-radius: var(--radius-full); /* pill */
  padding: 10px 16px 10px 40px; /* LTR: padding-left for icon */
  /* RTL: padding: 10px 40px 10px 16px; */
  font-size: 14px;
  min-width: 280px;
}
```

---

### 7.5 Sidebar / Navigation

```css
.sidebar {
  background: var(--color-white);
  border-left: 1px solid var(--color-warm-200); /* RTL: border-left */
  width: 240px;
  padding: 16px 12px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-md); /* 8px */
  font-size: 14px;
  font-weight: 400;
  color: var(--color-warm-500);
  cursor: pointer;
  transition: all 150ms ease-out;
}
.nav-item:hover {
  background: var(--color-warm-50);
  color: var(--color-warm-700);
}
.nav-item.active {
  background: var(--color-saffron-50);
  color: var(--color-saffron-700);
  font-weight: 500;
}
.nav-item.active .nav-icon {
  color: var(--color-saffron-500);
}
.nav-icon {
  width: 20px;
  height: 20px;
  color: var(--color-warm-400);
  transition: color 150ms ease-out;
}
.nav-item:hover .nav-icon {
  color: var(--color-warm-600);
}
```

**Rules:**
- Sidebar is white, not dark. (Dark sidebar is an option — see Dark Mode section.)
- Active item uses saffron-50 background + saffron-700 text. NOT saffron-500 background.
- Icons are 20px, 1.5px stroke, single color.
- Collapsed sidebar (icon-only): 72px wide. Items center-aligned.

---

### 7.6 Tabs

```css
.tabs {
  display: flex;
  gap: 4px;
  background: var(--color-warm-100);
  padding: 4px;
  border-radius: var(--radius-md);
  width: fit-content;
}
.tab {
  padding: 8px 16px;
  border-radius: var(--radius-sm); /* 6px */
  font-size: 14px;
  font-weight: 400;
  color: var(--color-warm-500);
  cursor: pointer;
  border: none;
  background: transparent;
  transition: all 150ms ease-out;
}
.tab:hover {
  color: var(--color-warm-700);
}
.tab.active {
  background: var(--color-white);
  color: var(--color-warm-900);
  font-weight: 500;
  box-shadow: var(--shadow-sm);
}
```

**Alternative (underline tabs):**
```css
.tab-underline {
  padding: 10px 4px;
  font-size: 14px;
  color: var(--color-warm-500);
  border-bottom: 2px solid transparent;
  background: transparent;
  border-top: none;
  border-left: none;
  border-right: none;
  cursor: pointer;
}
.tab-underline.active {
  color: var(--color-saffron-600);
  border-bottom-color: var(--color-saffron-500);
  font-weight: 500;
}
```

---

### 7.7 Badges, Tags & Status Pills

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 500;
}
.badge-success {
  background: var(--color-success-bg);
  color: var(--color-success);
}
.badge-warning {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}
.badge-danger {
  background: var(--color-danger-bg);
  color: var(--color-danger);
}
.badge-info {
  background: var(--color-info-bg);
  color: var(--color-info);
}
.badge-saffron {
  background: var(--color-saffron-100);
  color: var(--color-saffron-700);
}
```

**Status dot:**
```css
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.success { background: var(--color-success); }
.status-dot.warning { background: var(--color-warning); }
.status-dot.danger { background: var(--color-danger); }
```

---

### 7.8 Category Pills (POS)

```css
.cat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 500;
  background: var(--color-white);
  color: var(--color-warm-600);
  border: 1px solid var(--color-warm-200);
  cursor: pointer;
  transition: all 150ms ease-out;
  white-space: nowrap;
}
.cat-pill:hover {
  border-color: var(--color-warm-300);
  color: var(--color-warm-800);
}
.cat-pill.active {
  background: var(--color-warm-900);
  color: var(--color-white);
  border-color: var(--color-warm-900);
}
.cat-pill .count {
  font-size: 11px;
  color: var(--color-warm-400);
}
.cat-pill.active .count {
  color: var(--color-warm-400);
}
```

---

### 7.9 Product Cards (POS Grid)

```css
.product-card {
  background: var(--color-white);
  border-radius: var(--radius-xl); /* 16px */
  border: 1px solid var(--color-warm-200);
  overflow: hidden;
  transition: box-shadow 150ms ease-out, transform 150ms ease-out;
  cursor: pointer;
}
.product-card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
.product-image {
  width: 100%;
  aspect-ratio: 4/3;
  background: var(--color-warm-100);
  object-fit: cover;
}
.product-image-placeholder {
  width: 100%;
  aspect-ratio: 4/3;
  background: var(--color-warm-100);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-warm-300);
}
.product-info {
  padding: 12px;
}
.product-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-warm-900);
  margin-bottom: 4px;
}
.product-price {
  font-size: 15px;
  font-weight: 500;
  color: var(--color-warm-900);
  font-variant-numeric: tabular-nums;
}
.product-add {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--color-saffron-500);
  color: white;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  cursor: pointer;
  transition: background 150ms ease-out;
}
.product-add:hover {
  background: var(--color-saffron-600);
}
```

---

### 7.10 Cart Panel (POS Right Side)

```css
.cart-panel {
  background: var(--color-white);
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-warm-200);
  padding: var(--space-4);
  height: 100%;
  display: flex;
  flex-direction: column;
}
.cart-header {
  font-size: var(--text-h3);
  font-weight: 500;
  color: var(--color-warm-900);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-warm-100);
}
.cart-items {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3) 0;
}
.cart-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-warm-100);
}
.cart-item:last-child {
  border-bottom: none;
}
.cart-item-name {
  font-size: 14px;
  color: var(--color-warm-700);
}
.cart-item-qty {
  font-size: 12px;
  color: var(--color-warm-400);
  background: var(--color-warm-100);
  padding: 2px 8px;
  border-radius: var(--radius-full);
}
.cart-item-price {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-warm-900);
  font-variant-numeric: tabular-nums;
}
.cart-summary {
  border-top: 1px solid var(--color-warm-200);
  padding-top: var(--space-3);
}
.cart-row {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--color-warm-500);
  padding: 4px 0;
}
.cart-total {
  display: flex;
  justify-content: space-between;
  font-size: 16px;
  font-weight: 500;
  color: var(--color-warm-900);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-warm-100);
}
.cart-pay-btn {
  width: 100%;
  margin-top: var(--space-4);
  padding: 14px;
  border-radius: var(--radius-lg);
  background: var(--color-saffron-500);
  color: white;
  border: none;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: background 150ms ease-out;
}
.cart-pay-btn:hover {
  background: var(--color-saffron-600);
}
.cart-pay-btn:disabled {
  background: var(--color-warm-200);
  color: var(--color-warm-400);
}
```

---

### 7.11 Empty States

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 24px;
  text-align: center;
}
.empty-icon {
  width: 56px;
  height: 56px;
  color: var(--color-warm-300);
  margin-bottom: 16px;
}
.empty-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--color-warm-700);
  margin-bottom: 6px;
}
.empty-desc {
  font-size: 14px;
  color: var(--color-warm-400);
  max-width: 320px;
}
.empty-action {
  margin-top: 20px;
}
```

---

### 7.12 Modals & Dialogs

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.40);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--color-white);
  border-radius: var(--radius-xl); /* 16px */
  box-shadow: var(--shadow-xl);
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.modal-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--color-warm-100);
}
.modal-title {
  font-size: 18px;
  font-weight: 500;
  color: var(--color-warm-900);
}
.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  flex: 1;
}
.modal-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--color-warm-100);
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
```

---

### 7.13 Toast / Notification

```css
.toast {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  background: var(--color-white);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--color-warm-200);
  font-size: 14px;
  color: var(--color-warm-700);
}
.toast-success {
  border-left: 3px solid var(--color-success); /* RTL: border-right */
}
.toast-warning {
  border-left: 3px solid var(--color-warning);
}
.toast-danger {
  border-left: 3px solid var(--color-danger);
}
```

---

### 7.14 Top Header / App Bar

```css
.app-header {
  height: 64px;
  background: var(--color-white);
  border-bottom: 1px solid var(--color-warm-200);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
}
.app-header-title {
  font-size: 18px;
  font-weight: 500;
  color: var(--color-warm-900);
}
.app-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
```

---

## 8. Layout Rules

### 8.1 Page Structure

```
┌─────────────────────────────────────────────┐
│  App Header (64px)                           │
├──────────┬──────────────────────────────────┤
│          │  Page Title + Actions             │
│ Sidebar  ├──────────────────────────────────┤
│ (240px)  │                                   │
│          │  Content Area                     │
│          │  (padding: 24px)                  │
│          │                                   │
│          │  Cards / Tables / Grids           │
│          │                                   │
└──────────┴──────────────────────────────────┘
```

### 8.2 Content Area Max Width

- **Dashboard / Reports:** Full width, fluid.
- **Forms / Detail views:** Max-width `720px`, centered.
- **Tables / Lists:** Full width, fluid.
- **POS Terminal:** Full width, no max-width. Split: menu grid (flex: 1) + cart (380px fixed).

### 8.3 Grid System

Use CSS Grid with these column patterns:
- **KPI row:** `grid-template-columns: repeat(4, 1fr)` (desktop), `repeat(2, 1fr)` (tablet)
- **Product grid:** `grid-template-columns: repeat(auto-fill, minmax(180px, 1fr))`
- **Form 2-column:** `grid-template-columns: 1fr 1fr` with `gap: 16px`

---

## 9. RTL (Right-to-Left) Guidelines

The application is Arabic. Every directional property must be logical or manually flipped.

### 9.1 CSS Logical Properties

| Instead of | Use |
|------------|-----|
| `margin-left` | `margin-inline-start` |
| `margin-right` | `margin-inline-end` |
| `padding-left` | `padding-inline-start` |
| `padding-right` | `padding-inline-end` |
| `border-left` | `border-inline-start` |
| `border-right` | `border-inline-end` |
| `text-align: left` | `text-align: start` |
| `text-align: right` | `text-align: end` |
| `float: left` | `float: inline-start` |
| `float: right` | `float: inline-end` |

### 9.2 Icon Direction

- **Arrow icons:** Must flip horizontally in RTL (`transform: scaleX(-1)`).
- **Chevrons / carets:** Pointing right in LTR → pointing left in RTL.
- **Back button arrow:** Points right in RTL.

### 9.3 Sidebar

- In RTL: Sidebar is on the **right** side of the screen.
- Border: `border-inline-start: 1px solid var(--color-warm-200)` instead of `border-right`.

### 9.4 Cart Panel (POS)

- In RTL: Cart panel is on the **left** side.
- Use `order` or flex direction to swap positions.

---

## 10. Dark Mode Tokens

When dark mode is enabled, swap to these values:

| Token | Light | Dark |
|-------|-------|------|
| `--color-bg-canvas` | `#FAFAF9` | `#0C0A09` |
| `--color-bg-surface` | `#FFFFFF` | `#1C1917` |
| `--color-bg-elevated` | `#FFFFFF` | `#292524` |
| `--color-text-primary` | `#1C1917` | `#FAFAF9` |
| `--color-text-secondary` | `#57534E` | `#A8A29E` |
| `--color-text-muted` | `#A8A29E` | `#78716C` |
| `--color-border` | `#E7E5E4` | `#44403C` |
| `--color-saffron-500` | `#F59E0B` | `#FBBF24` (brighter for contrast) |
| `--shadow-md` | `0 1px 3px rgba(0,0,0,0.06)` | `0 1px 3px rgba(0,0,0,0.30)` |

---

## 11. Animation & Motion

| Token | Value | Usage |
|-------|-------|-------|
| `--duration-micro` | 60ms | Checkbox toggle, switch |
| `--duration-fast` | 150ms | Button hover, color changes, opacity |
| `--duration-normal` | 250ms | Card hover lift, dropdown open |
| `--duration-slow` | 350ms | Modal open, page transition |
| `--ease-out` | `cubic-bezier(0,0,0.2,1)` | Most transitions |
| `--ease-standard` | `cubic-bezier(0.4,0,0.2,1)` | Complex multi-property |

### 11.1 Motion Rules

- All interactive elements must have a hover state.
- Buttons: `transform: scale(0.98)` on active/press.
- Cards: `translateY(-1px)` + shadow increase on hover.
- Modals: Fade in overlay + scale up content from 0.95 to 1.
- Dropdowns: Fade in + slide down 4px.
- **No bouncy/spring animations.** Keep it snappy and professional.
- **Respect `prefers-reduced-motion`:** If true, disable all transforms and use instant state changes.

---

## 12. What to Change vs. What NOT to Touch

### ✅ CHANGE THESE (Safe — Visual Only)

1. **CSS variables / design tokens** — colors, fonts, spacing, radius, shadows.
2. **Component class names** — apply new styles to existing component selectors.
3. **Icon colors** — change stroke/fill colors via CSS.
4. **Background images / patterns** — remove or replace decorative assets.
5. **Border styles** — change width, color, radius.
6. **Padding and margin values** — snap to the spacing scale.
7. **Font sizes and weights** — apply the type scale.
8. **Box shadows** — apply the elevation system.
9. **Transition/animation values** — duration, easing.
10. **RTL fixes** — swap left/right to logical properties where broken.

### ❌ DO NOT TOUCH THESE (Will Break Logic)

1. **Component file structure** — don't rename, move, or delete component files.
2. **Props and prop types** — keep all existing props.
3. **State management** — don't change useState, useReducer, stores, or context.
4. **Event handlers** — onClick, onChange, onSubmit, etc. Keep the functions.
5. **Data fetching** — API calls, queries, mutations, loading states logic.
6. **Routing** — route paths, navigation logic, guards.
7. **Form validation** — validation rules, error messages content (style them, don't change logic).
8. **Conditional rendering** — `if (loading) return <Spinner />` — style the spinner, don't remove the condition.
9. **Rust/Tauri commands** — don't touch `invoke()` calls or backend commands.
10. **LocalStorage / persistence** — keys, serialization logic.
11. **Business logic** — tax calculation, discount rules, inventory math.
12. **Component hierarchy** — parent-child relationships, slots.

---

## 13. Implementation Order

Follow this order to avoid chaos:

### Phase 1: Foundation (1–2 hours)
1. Add Inter font to the project.
2. Define CSS variables (the full token set) in a global CSS file.
3. Set the global body styles (font, background, color).

### Phase 2: Layout Shell (2–3 hours)
4. Style the sidebar (colors, active state, radius).
5. Style the app header (height, border, typography).
6. Style the main content area (padding, background).

### Phase 3: Components (4–6 hours)
7. Buttons (primary, secondary, ghost, icon).
8. Cards (default, KPI, product).
9. Tables (header, rows, hover, status badges).
10. Inputs (text, search, select, textarea).
11. Tabs (pill style and underline style).
12. Badges and status pills.

### Phase 4: Page-Specific (3–4 hours)
13. POS terminal (product grid, category pills, cart panel).
14. Inventory page (table, filters, empty state).
15. Dashboard (KPI cards, charts styling).
16. Settings / forms.

### Phase 5: Polish (2–3 hours)
17. Empty states across all pages.
18. Modals and dialogs.
19. Toasts and notifications.
20. Hover states and transitions.
21. RTL verification.
22. Dark mode tokens (if applicable).

---

## 14. Quick Reference Cheat Sheet

```css
/* === GLOBAL VARIABLES === */
:root {
  /* Saffron */
  --color-saffron-50: #FFFBEB;
  --color-saffron-100: #FEF3C7;
  --color-saffron-200: #FDE68A;
  --color-saffron-300: #FCD34D;
  --color-saffron-400: #FBBF24;
  --color-saffron-500: #F59E0B;
  --color-saffron-600: #D97706;
  --color-saffron-700: #B45309;
  --color-saffron-800: #92400E;
  --color-saffron-900: #78350F;

  /* Warm Neutrals */
  --color-white: #FFFFFF;
  --color-warm-50: #FAFAF9;
  --color-warm-100: #F5F5F4;
  --color-warm-200: #E7E5E4;
  --color-warm-300: #D6D3D1;
  --color-warm-400: #A8A29E;
  --color-warm-500: #78716C;
  --color-warm-600: #57534E;
  --color-warm-700: #44403C;
  --color-warm-800: #292524;
  --color-warm-900: #1C1917;

  /* Semantic */
  --color-success: #16A34A;
  --color-success-bg: color-mix(in srgb, #16A34A 10%, transparent);
  --color-warning: #D97706;
  --color-warning-bg: color-mix(in srgb, #D97706 10%, transparent);
  --color-danger: #DC2626;
  --color-danger-bg: color-mix(in srgb, #DC2626 10%, transparent);
  --color-info: #2563EB;
  --color-info-bg: color-mix(in srgb, #2563EB 10%, transparent);

  /* Typography */
  --font-sans: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', monospace;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-lg: 0 4px 12px rgba(0,0,0,0.08);
  --shadow-xl: 0 8px 24px rgba(0,0,0,0.10);

  /* Motion */
  --duration-micro: 60ms;
  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --duration-slow: 350ms;
  --ease-out: cubic-bezier(0,0,0.2,1);
  --ease-standard: cubic-bezier(0.4,0,0.2,1);
}

/* === GLOBAL RESET === */
body {
  font-family: var(--font-sans);
  background: var(--color-warm-50);
  color: var(--color-warm-900);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Tabular nums for all prices, quantities, IDs */
.price, .quantity, .id, .count {
  font-variant-numeric: tabular-nums;
}

/* Scrollbar styling */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-warm-300); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-warm-400); }
```

---

## 15. Notes for Tauri + Rust Stack

- **Font bundling:** Since Tauri apps run offline, bundle Inter font files in your `src/assets/fonts/` and load via `@font-face`. Do not rely on Google Fonts CDN.
- **CSS framework:** If you're using Tailwind, map these tokens to `tailwind.config.js` `extend` section. If plain CSS, use the variables above.
- **Theme switching:** Store theme preference in Tauri's `localStorage` or Rust-side config. Apply a `data-theme="dark"` attribute to `<html>` and use `[data-theme="dark"]` selectors.
- **RTL detection:** Check `document.dir === 'rtl'` and conditionally apply RTL overrides if logical properties aren't sufficient.
- **Performance:** All transitions use `transform` and `opacity` only (GPU-accelerated). No `width`, `height`, `top`, `left` animations.

---

*End of Design Bible. Apply surgically. Test every page. Do not rush.*
