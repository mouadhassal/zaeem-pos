// A restaurant's day does not end at midnight: the 01:30 orders of a Friday night belong to Friday.
// The business day starts at 05:00 local time -- the same rule as the daily order numbers and the
// order history (src-tauri/src/order_history.rs). Everything that says "today" (the AI assistant,
// the dashboard, the reports' quick ranges) uses this, so "today" does not empty itself at 00:00.

export const BUSINESS_DAY_START_HOUR = 5;

/** When the business day that `now` belongs to began (05:00 today, or 05:00 yesterday before 05:00). */
export function businessDayStart(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(BUSINESS_DAY_START_HOUR, 0, 0, 0);
  if (now.getTime() < d.getTime()) d.setDate(d.getDate() - 1);
  return d;
}

/** Start of the business week (Sunday's business day), month (the 1st's) or year (1 January's) that `now` is in. */
export function businessPeriodStart(period: "day" | "week" | "month" | "year", now: Date = new Date()): Date {
  const d = businessDayStart(now);
  if (period === "week") d.setDate(d.getDate() - d.getDay());
  if (period === "month") d.setDate(1);
  if (period === "year") d.setMonth(0, 1);
  return d;
}
