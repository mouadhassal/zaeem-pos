// Pure helpers for the finance screens (rent, expense reports). No invoke, no DOM.
// The numbers themselves come from src-tauri/src/finance.rs.

export type RentPeriod = "DAILY" | "MONTHLY" | "YEARLY";

export const RENT_PERIODS: { value: RentPeriod; label: string; per: string }[] = [
  { value: "MONTHLY", label: "شهري", per: "في الشهر" },
  { value: "DAILY", label: "يومي", per: "في اليوم" },
  { value: "YEARLY", label: "سنوي", per: "في السنة" },
];

export function rentPeriodLabel(p: string): string {
  return RENT_PERIODS.find((x) => x.value === p)?.label ?? p;
}

export const PAYMENT_METHODS = [
  { value: "CASH", label: "نقداً" },
  { value: "CARD", label: "بطاقة" },
  { value: "TRANSFER", label: "تحويل" },
  { value: "OTHER", label: "أخرى" },
] as const;

export function paymentMethodLabel(v: string | null | undefined): string {
  return PAYMENT_METHODS.find((m) => m.value === v)?.label ?? "";
}

export type CostGroupBy = "category" | "period" | "cost_centre";

export const COST_GROUPS: { value: CostGroupBy; label: string }[] = [
  { value: "category", label: "حسب البند" },
  { value: "period", label: "حسب الشهر" },
  { value: "cost_centre", label: "حسب مركز التكلفة" },
];

/** "2026-11" for a local date (or "YYYY-MM-DD" text). */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The month part of the rent row as a plain label: 2026-11 -> "2026-11". Kept as text so digits stay western. */
export function remainingText(remaining: number, fmt: (c: number) => string): string {
  if (remaining < 0) return `مدفوع مقدماً ${fmt(-remaining)}`;
  if (remaining === 0) return "مسدّد";
  return fmt(remaining);
}

/** The first and last day (YYYY-MM-DD) of the month 2026-11 -> ["2026-11-01", "2026-11-30"]. */
export function monthRange(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}
