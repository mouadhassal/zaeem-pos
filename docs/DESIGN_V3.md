# DESIGN_V3.md — Zaeem Design System

**Supersedes `DESIGN_V2.md` entirely. Delete it.** The dark "instrument" direction is dead — it was
the wrong read of the market. This document is the only design authority.

**Direction:** warm, light, premium, generous. Rich enough that an owner feels the product is worth
paying for; disciplined enough that a cashier can work it at speed.

---

## 1. Tokens

### Colour

```
/* canvas & surfaces */
--bg          #F5F6F8    app canvas
--surface     #FFFFFF    cards, panels, sidebar
--surface-alt #F2F4F7    inset controls, inactive chips, secondary buttons

/* text */
--text        #101828    primary
--text-2      #475467    secondary
--text-3      #667085    tertiary
--text-muted  #98A2B3    placeholders, meta, hints

/* lines */
--line        #E4E7EC    dividers, dashed rules
--line-2      #F2F4F7    row separators

/* THE accent — persimmon */
--accent      #F04E23
--accent-soft #FDEDE8    tints, active nav background, category wash
--accent-text #C43A14    accent text on a soft-accent fill (contrast)

/* category washes — decorative ONLY on category tiles/glyphs */
--cat-meat    #FDEDE8 / glyph #F04E23
--cat-grill   #FBF0DE / glyph #C4841D
--cat-drink   #E8F1FB / glyph #3E8BD8
--cat-salad   #E9F4EE / glyph #2E8B5B
--cat-sweet   #F3EDFB / glyph #7B5BC4
--cat-other   #F2F4F7 / glyph #667085

/* state — these are the ONLY other saturated colours in the product */
--ok          #12A150    paid, in stock, synced
--warn        #E8A317    late, low stock, expiring
--danger      #E03B3B    void, overdue, discrepancy, tamper
```

### The accent rule

`--accent` may appear in exactly these places, and nowhere else:

1. The logo mark
2. The active nav item (soft fill + accent text)
3. The **PAY** key
4. The **+ button of an item already in the cart** — the accent carries *state*: the cashier sees
   what's in the order without looking at the cart

Not on prices. Not on headers. Not on badges. Not on borders. **If you can point at something
accent-coloured and it isn't telling the user something true, make it ink.**

### Type

| Role | Face | Notes |
|---|---|---|
| UI (Arabic + Latin) | **Tajawal** | 400 / 500 / 700. Geometric, modern, confident. Not the corporate default. |
| **All numerals** | **IBM Plex Mono, `font-variant-numeric: tabular-nums`** | Money, quantity, order #, time, stock. **Always.** Digits must align in a column so the eye compares without reading. |

Remove Inter and IBM Plex Sans Arabic. Tajawal replaces both.
Arabic `line-height: 1.6`. Latin `1.4`.
Money uses **Western digits (0–9)**; quantities may use Eastern (٠١٢). Never mix within one element.

### Geometry & depth

```
radius:  cards 13px · buttons/chips 10-12px · small controls 7-9px · avatars 50%
shadow:  --sh-1   0 1px 2px rgba(16,24,40,.05)                            (cards)
         --sh-2   0 1px 2px rgba(16,24,40,.05), 0 6px 16px rgba(16,24,40,.04)   (menu cards)
         --sh-3   0 1px 2px rgba(16,24,40,.05), 0 8px 24px rgba(16,24,40,.05)   (order panel)
spacing: 4px base. Card padding 10–14px. Panel padding 14–16px.
```

Shadows are soft and cheap — **two layers maximum, never a third.** No borders on cards; the shadow
is the edge. Borders only on inset controls.

### Touch & motion

- **Minimum target 44px. PAY key 50px+. Numpad keys 44px+.**
- **Nothing is discoverable by hover.** No tooltips, no hover-reveal, no right-click. There is no
  mouse.
- Motion budget: state flips under 100ms. Card press = `scale(0.98)`, 80ms. The KDS aging bar is the
  only continuous animation in the product. **A POS that animates feels broken.**

---

## 2. The photo problem — solved, not hidden

Restoe leans on food photography. **You have none, and a Damascus owner will never shoot 140 dishes.**
The current build prints "لا توجد صورة" on a grey box, which looks broken.

**Glyph-first, photo-optional.**

- Every item tile has a **62px header**: the category wash colour + the category glyph at 55% opacity.
- When a photo exists, it fills the same 62px header. Identical geometry, zero layout shift.
- **A restaurant with zero photos looks finished.** That is the point: it's what makes "live in 20
  minutes" true, and it's the thing neither reference does.

Category → wash + glyph mapping lives in one config, editable by the owner.

---

## 3. Screens

### 3.1 POS — the money screen (80% of all screen-time)

RTL layout, right to left:

```
[ sidebar 152px ] [ menu — flex ] [ order panel 226px ]
```

**Sidebar** — white, labelled (as requested), **six items only**: نقاط البيع · المطبخ · القائمة ·
المخزون · التقارير · الموظفين. F-key hint right-aligned, 9px, muted. Active = `--accent-soft` fill +
accent text + accent icon. User chip pinned to the bottom with the current shift.
The other eight nav items move to **back-office**. A cashier never opens them.

**Menu column** — search bar (44px) + category chips (icon + label) + item grid.
At 1366×768 the grid is **3 columns × 3 rows = 9 items**. Do not squeeze more in.

Item card: 13px radius, `--sh-2`, 62px glyph header, name (13px/500), then a row with
**price (Plex Mono tabular, ink)** and the **stepper**.
Stepper: `+` only when qty is 0 (`--surface-alt`); when qty > 0 it becomes `[qty] [+]` and the `+`
turns **accent**. One tap adds a quantity without ever touching the cart. This is the single best
interaction in your references — take it.

**Order panel** — white card, `--sh-3`, 14px radius, floating on the canvas with a 16px gutter.
- Header: الطلبية + order # in a mono chip
- Rows: 34px category thumbnail · name · `qty × unit` in mono muted · line total in mono ink
- Divider: **dashed** `--line` (the only dashed rule in the product — it says *receipt*)
- **THE TOTAL IS THE HERO.** Plex Mono, 500, `letter-spacing: -0.02em`, **44px at 1366×768**, ink.
  USD equivalent above it, 11px, muted. Readable across a counter while handing over change.
- **PAY**: 50px, full width, `--accent`, 12px radius. Hold button beside it, `--surface-alt`.

**Numpad**: appears in the menu column footer when a quantity or cash-tendered entry is active.
Not permanently docked — it steals space that items need.

### 3.2 KDS — the signature

The **ticket rail**. Each ticket carries a hairline bar that fills left→right over the item's target
prep time and shifts `--line → --warn → --danger` as it passes target.

A chef reads the entire kitchen in one glance, from across a hot room, without reading a word or a
number. **Time is the information; the bar is the time.** Build this properly and build nothing that
competes with it for attention.

Tickets: white cards on `--bg`, large type (kitchen screens are viewed from 1.5–2m — everything is
+2 sizes from POS). Replace the 3s polling loop with an event push from Rust.

### 3.3 Login

**PIN pad.** A cashier logs in twenty times a shift; nobody types an email at a POS.
Email/password persists for owner and back-office only. Big keys, no decoration, no gradient, no
canvas.

### 3.4 Back-office

Same tokens, **lower density, more air**. The owner reads this sitting down, on a phone, in the
morning. Four numbers and one alarming sentence — not a wall of charts.

---

## 4. Copy

Words are design material. Arabic, sentence case, active voice, plain verbs.

- The button that says **دفع** produces a toast that says **تم الدفع.** An action keeps its name
  through the whole flow.
- Errors say what happened and what to do, and never apologise:
  > **الطابعة "المطبخ-١" ما جاوبت. الطلب محفوظ.**
  > أعد الطباعة · اعرض التذكرة على الشاشة
- Empty states are an instruction: **ما في طلبات هلق.** اختر طاولة لتبدأ.
- **Ban "حدث خطأ ما".** It's a confession that we didn't handle the case.

---

## 5. Quality floor — non-negotiable

- **Contrast:** every text/background pair ≥ 4.5:1. Measure it. The current build has grey-on-grey
  item names that are invisible in a shopfront at 14:00.
- **Currency:** `MoneyPolicy` from the market pack decides the symbol. **The current build shows
  ر.س — Saudi riyal. Syria is ل.س with a USD secondary.** This is a bug, not a preference.
- Every touch target measured, none under 44px.
- Zero `Something went wrong` strings in any locale file.
- 1366×768 is the design target. Test there, not on your 1920 monitor.
