# Color Palette — White-First with Saffron Whisper

> **Philosophy:** White is the hero. Saffron is the accent — used like a spice, not the main dish.  
> The background has a warm, barely-there saffron glow. Everything feels airy, modern, and expensive.

---

## 1. Backgrounds — The Saffron Glow

| Token | Hex | Usage |
|-------|-----|-------|
| `--bg-canvas` | `#FFFCF7` | **Main app background.** Not gray. Not white. A warm, milky cream with the faintest saffron breath. |
| `--bg-canvas-glow` | `radial-gradient(ellipse 80% 60% at 50% 0%, rgba(245,158,11,0.04) 0%, transparent 70%)` | **Optional overlay.** A soft saffron light bloom from the top-center. Like morning sun hitting the page. |
| `--bg-card` | `#FFFFFF` | Cards, panels, modals, inputs — pure white. Crisp. Clean. |
| `--bg-elevated` | `#FFFFFF` | Dropdowns, popovers, toasts — same white, lifted by shadow. |
| `--bg-sidebar` | `#FFFFFF` | Sidebar — white. Let the content breathe. |
| `--bg-hover` | `#FFF7ED` | Very light saffron tint for hover states. Warm, not orange. |
| `--bg-active` | `#FFFBEB` | Saffron-50. Active nav item, selected row. |

### The Glow Effect (CSS)

```css
body {
  background: var(--bg-canvas);
  position: relative;
}

/* Optional: add a subtle saffron glow layer */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background: radial-gradient(
    ellipse 70% 50% at 50% -10%,
    rgba(251, 191, 36, 0.06) 0%,
    transparent 60%
  );
  pointer-events: none;
  z-index: 0;
}
```

> **Note:** The glow is `pointer-events: none` and `z-index: 0`. It never interferes with clicks.  
> On dark mode, flip to a subtle warm amber glow from the bottom instead.

---

## 2. Text Colors — Cool Gray, Not Warm

| Token | Hex | Usage |
|-------|-----|-------|
| `--text-primary` | `#0F172A` | Headings, primary values, key data. Near-black with a cool blue undertone. |
| `--text-secondary` | `#475569` | Body text, descriptions, table content. Slate-600. |
| `--text-muted` | `#94A3B8` | Captions, placeholders, metadata, disabled. Slate-400. |
| `--text-inverse` | `#FFFFFF` | Text on saffron buttons or dark surfaces. |

> **Why cool gray?** It balances the warm saffron. Warm gray + warm accent = muddy. Cool gray + warm accent = crisp and premium.

---

## 3. Saffron — The Whisper

| Token | Hex | Usage |
|-------|-----|-------|
| `--saffron-50` | `#FFFBEB` | Active backgrounds, hover tints, focus ring fill. |
| `--saffron-100` | `#FEF3C7` | Badge backgrounds, tag fills. |
| `--saffron-200` | `#FDE68A` | Decorative accents, chart highlights. |
| `--saffron-300` | `#FCD34D` | Icon accents on saffron backgrounds. |
| `--saffron-400` | `#FBBF24` | Hover states on primary buttons. |
| `--saffron-500` | `#F59E0B` | **PRIMARY SAFFRON.** The ONE button per screen. Active tab underline. |
| `--saffron-600` | `#D97706` | Primary button pressed state. |

### Saffron Usage Rules — STRICT

1. **ONE saffron button per screen.** That's it. The "Pay" button. The "Save" button. The "Add Item" button. Pick the single most important action.
2. **Secondary buttons** = white bg, slate border, slate text. No saffron.
3. **Ghost buttons** = transparent bg, slate text. No saffron.
4. **Nav active state** = saffron-50 background + saffron-700 text. NOT saffron-500 bg.
5. **Focus rings** = `0 0 0 3px var(--saffron-50)` + `border-color: var(--saffron-400)`. Subtle.
6. **Tab underline** = 2px saffron-500. Thin. Precise.
7. **Trend arrows / positive indicators** = saffron-500. NOT green.
8. **NO saffron text.** Never use saffron for body text, headings, or labels.
9. **NO saffron borders.** Use slate-200 for all borders.
10. **NO saffron card backgrounds.** Cards are white. Always.

---

## 4. Neutral / Slate System

| Token | Hex | Usage |
|-------|-----|-------|
| `--slate-50` | `#F8FAFC` | Alternative canvas (if you want cooler). |
| `--slate-100` | `#F1F5F9` | Table header bg, subtle separators. |
| `--slate-200` | `#E2E8F0` | Borders, dividers, input borders. |
| `--slate-300` | `#CBD5E1` | Disabled borders, placeholder text. |
| `--slate-400` | `#94A3B8` | Muted text, icons inactive. |
| `--slate-500` | `#64748B` | Secondary text, labels. |
| `--slate-600` | `#475569` | Body text. |
| `--slate-700` | `#334155` | Emphasized body, subheadings. |
| `--slate-800` | `#1E293B` | Strong headings. |
| `--slate-900` | `#0F172A` | Primary text, headings. |

---

## 5. Semantic Status Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--success` | `#16A34A` | Paid, completed, available, in-stock. |
| `--success-bg` | `#F0FDF4` | Success badge bg. |
| `--warning` | `#D97706` | Pending, cooking, processing. |
| `--warning-bg` | `#FFFBEB` | Warning badge bg. |
| `--danger` | `#DC2626` | Cancelled, error, low stock. |
| `--danger-bg` | `#FEF2F2` | Danger badge bg. |
| `--info` | `#2563EB` | Links, info badges. |
| `--info-bg` | `#EFF6FF` | Info badge bg. |

---

## 6. Shadows — Soft & Warm

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,0.04)` | Subtle lift. |
| `--shadow-md` | `0 1px 3px rgba(15,23,42,0.05), 0 1px 2px rgba(15,23,42,0.03)` | **Default card shadow.** Invisible but present. |
| `--shadow-lg` | `0 4px 12px rgba(15,23,42,0.06)` | Dropdowns, popovers, hovered cards. |
| `--shadow-xl` | `0 8px 24px rgba(15,23,42,0.08)` | Modals. |
| `--shadow-glow` | `0 0 24px rgba(245,158,11,0.12)` | Saffron glow on focused primary buttons. Optional. |

---

## 7. Component Quick Reference (White-First)

### Primary Button (The ONE Saffron Button)
```css
.btn-primary {
  background: linear-gradient(180deg, #FBBF24 0%, #F59E0B 100%);
  color: #FFFFFF;
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  border: none;
  box-shadow: 0 1px 2px rgba(245,158,11,0.25), 0 0 0 1px rgba(245,158,11,0.1) inset;
  transition: all 150ms ease-out;
}
.btn-primary:hover {
  background: linear-gradient(180deg, #F59E0B 0%, #D97706 100%);
  box-shadow: 0 4px 12px rgba(245,158,11,0.25), var(--shadow-glow);
  transform: translateY(-1px);
}
.btn-primary:active {
  transform: scale(0.98) translateY(0);
  box-shadow: 0 1px 2px rgba(245,158,11,0.2);
}
```

### Secondary Button (White, Slate Border)
```css
.btn-secondary {
  background: #FFFFFF;
  color: #334155;
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  border: 1px solid #E2E8F0;
  transition: all 150ms ease-out;
}
.btn-secondary:hover {
  background: #F8FAFC;
  border-color: #CBD5E1;
  color: #0F172A;
}
```

### Card
```css
.card {
  background: #FFFFFF;
  border-radius: 16px;
  border: 1px solid #F1F5F9; /* very subtle border */
  box-shadow: var(--shadow-md);
  padding: 20px;
}
```

### Sidebar Nav Active
```css
.nav-item.active {
  background: #FFFBEB; /* saffron-50 */
  color: #B45309; /* saffron-700 */
  font-weight: 500;
}
/* NO saffron background on the icon. NO saffron-500 bg. */
```

### Input Focus
```css
.input:focus {
  outline: none;
  border-color: #FBBF24; /* saffron-400 */
  box-shadow: 0 0 0 3px #FFFBEB; /* saffron-50 ring */
}
```

---

## 8. The Vibe Check

| Your old | New |
|----------|-----|
| Aggressive orange everywhere | Saffron on ONE button per screen |
| Gray / blue-gray background | Warm milky cream `#FFFCF7` with subtle glow |
| Dark sidebar | White sidebar, clean, airy |
| Heavy borders and shadows | Hairline borders, whisper shadows |
| Warm gray text | Cool slate text — crisp against warm bg |
| Multiple accent colors fighting | Saffron + slate only. Status colors for semantics only. |

---

## 9. CSS Variables (Drop-in)

```css
:root {
  /* === SAFFRON (whisper) === */
  --saffron-50: #FFFBEB;
  --saffron-100: #FEF3C7;
  --saffron-200: #FDE68A;
  --saffron-300: #FCD34D;
  --saffron-400: #FBBF24;
  --saffron-500: #F59E0B;
  --saffron-600: #D97706;
  --saffron-700: #B45309;

  /* === BACKGROUNDS === */
  --bg-canvas: #FFFCF7;
  --bg-card: #FFFFFF;
  --bg-elevated: #FFFFFF;
  --bg-sidebar: #FFFFFF;
  --bg-hover: #FFF7ED;
  --bg-active: #FFFBEB;

  /* === TEXT === */
  --text-primary: #0F172A;
  --text-secondary: #475569;
  --text-muted: #94A3B8;
  --text-inverse: #FFFFFF;

  /* === SLATE (structure) === */
  --slate-50: #F8FAFC;
  --slate-100: #F1F5F9;
  --slate-200: #E2E8F0;
  --slate-300: #CBD5E1;
  --slate-400: #94A3B8;
  --slate-500: #64748B;
  --slate-600: #475569;
  --slate-700: #334155;
  --slate-800: #1E293B;
  --slate-900: #0F172A;

  /* === SEMANTIC === */
  --success: #16A34A;
  --success-bg: #F0FDF4;
  --warning: #D97706;
  --warning-bg: #FFFBEB;
  --danger: #DC2626;
  --danger-bg: #FEF2F2;
  --info: #2563EB;
  --info-bg: #EFF6FF;

  /* === SHADOWS === */
  --shadow-sm: 0 1px 2px rgba(15,23,42,0.04);
  --shadow-md: 0 1px 3px rgba(15,23,42,0.05), 0 1px 2px rgba(15,23,42,0.03);
  --shadow-lg: 0 4px 12px rgba(15,23,42,0.06);
  --shadow-xl: 0 8px 24px rgba(15,23,42,0.08);
  --shadow-glow: 0 0 24px rgba(245,158,11,0.12);
}
```

---

*This is the palette. Saffron is the spice, not the meal. White is the king.*
