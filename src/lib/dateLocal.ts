// 2026-08-22 QA re-audit: `d.toISOString().slice(0, 10)` and
// `new Date("YYYY-MM-DD")` both silently disagree with the LOCAL calendar
// date in any timezone ahead of UTC -- including this app's own
// established Asia/Damascus (UTC+3) convention (see upsert_legacy_branch's
// hardcoded 'Asia/Damascus' in repo.rs). `toISOString()` converts to UTC
// first, so local midnight becomes the PREVIOUS day's date once sliced;
// the ISO date-only parse form is specified (ECMA-262) to parse as UTC
// midnight, which in Asia/Damascus lands at 03:00 local -- silently
// clipping the first 3 hours off any range boundary built that way. Both
// bugs were confirmed live: schedule/page.tsx's roster entries always
// landed one day off (commit 0b9059f), and finance/reports' date-range
// pickers and defaults were open to the same class of error. These two
// helpers are the one correct way to move between a `Date` and a
// "YYYY-MM-DD" string in this app -- always via local calendar
// components, never via `toISOString`.

/** Formats a Date as "YYYY-MM-DD" using its LOCAL calendar date. */
export function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parses a "YYYY-MM-DD" string as LOCAL midnight (not UTC midnight). */
export function parseLocalDateStr(s: string): Date {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}

// 2026-08-25 QA re-audit (design/UX consistency pass): every money value
// in this app deliberately formats with `toLocaleString("en-US", ...)` --
// Western digits -- see money.ts, ItemCard, OrderLine, OrderPanel,
// TotalBlock, MenuGridContainer. But every DATE across the app called
// `toLocaleDateString("ar-SA", ...)` directly, ~20 call sites across 12
// files (customers, debt, delivery, inventory, loyalty, reports,
// schedule, settings, staff, printer receipts) -- "ar-SA" alone renders
// Eastern Arabic-Indic digits (٢٢ أغسطس ٢٠٢٦), so a receipt or list row
// could show a price in Western digits right next to a date in Eastern
// Arabic-Indic ones, in the same UI, at the same time. Confirmed live via
// tauri-driver: the customers page's "آخر تعديل" column. `numberingSystem:
// "latn"` keeps the real Arabic month/weekday names while forcing Western
// digits -- these two helpers are now the one correct way to format a
// date for display anywhere in this app, matching money's own convention
// instead of drifting from it.
const WESTERN_DIGITS: Intl.DateTimeFormatOptions = { numberingSystem: "latn" };

/** Formats a Date for display -- Arabic month/weekday names, Western digits. */
export function formatArabicDate(d: Date, opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" }): string {
  return d.toLocaleDateString("ar-SA", { ...opts, ...WESTERN_DIGITS });
}

/** Same as `formatArabicDate` but includes a time-of-day component. */
export function formatArabicDateTime(d: Date, opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }): string {
  return d.toLocaleString("ar-SA", { ...opts, ...WESTERN_DIGITS });
}

/** Time-of-day only, Western digits -- same reasoning as formatArabicDate.
 * `toLocaleTimeString("ar-SA")` alone renders Eastern Arabic-Indic hour/
 * minute digits, which showed up on printed receipts (printer.ts) right
 * next to Western-digit prices on the same slip. */
export function formatArabicTime(d: Date, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }): string {
  return d.toLocaleTimeString("ar-SA", { ...opts, ...WESTERN_DIGITS });
}
