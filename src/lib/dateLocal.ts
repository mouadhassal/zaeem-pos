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
