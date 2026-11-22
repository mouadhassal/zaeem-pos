// Small pure helpers for the report tables: a row's share of the total, and how a period compares with
// the one before it. The comparison period is asked from the backend with the same call, so these only
// do the arithmetic and the wording.

/** `part` as a percent of `total`, one decimal (0 when there is no total). */
export function pctOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/** 12.5 -> "12.5%", 40 -> "40%". */
export function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "0%";
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

export type ChangeDir = "up" | "down" | "flat";

export interface Change {
  /** current - previous. */
  delta: number;
  /** Percent change against the previous period; null when there was nothing before (a new row). */
  pct: number | null;
  dir: ChangeDir;
}

export function changeOf(current: number, previous: number): Change {
  const delta = current - previous;
  const dir: ChangeDir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const pct = previous > 0 ? Math.round((delta / previous) * 1000) / 10 : previous === 0 && current === 0 ? 0 : null;
  return { delta, pct, dir };
}

/** "▲ 12.5%", "▼ 8%", "—" (no change), "جديد" (nothing in the period before). */
export function changeText(c: Change): string {
  if (c.pct === null) return "جديد";
  if (c.dir === "flat") return "—";
  return `${c.dir === "up" ? "▲" : "▼"} ${formatPct(Math.abs(c.pct))}`;
}

export type ChangeTone = "good" | "bad" | "neutral";

/** Up is green and down is red for sales; for cancellations or discounts it is the other way round. */
export function changeTone(c: Change, higherIsBetter = true): ChangeTone {
  if (c.dir === "flat") return "neutral";
  return (c.dir === "up") === higherIsBetter ? "good" : "bad";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The period to compare with. A period of a day or more is compared with the stretch of the same length
 * right before it; a part of a day ("today so far") with the same hours yesterday, because the stretch
 * right before would just be last night.
 */
export function previousRange(startIso: string, endIso: string): { startIso: string; endIso: string } {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const length = Math.max(0, end - start);
  if (length < DAY_MS) return { startIso: new Date(start - DAY_MS).toISOString(), endIso: new Date(end - DAY_MS).toISOString() };
  return { startIso: new Date(start - length).toISOString(), endIso: new Date(start - 1).toISOString() };
}

export interface BreakdownLike {
  key: string;
  label: string;
  count: number;
  amount_cents: number;
}

export interface CompareRow extends BreakdownLike {
  /** Share of the period's total, percent. */
  share: number;
  /** The same row in the previous period (0 when it had none). */
  previous_cents: number;
  change: Change;
}

/** Each row with its share of the total and its change against the same key in the previous period. */
export function withComparison(rows: BreakdownLike[], previous: BreakdownLike[] | null): CompareRow[] {
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  const prev = new Map((previous ?? []).map((r) => [r.key, r.amount_cents]));
  return rows.map((r) => {
    const before = prev.get(r.key) ?? 0;
    return { ...r, share: pctOf(r.amount_cents, total), previous_cents: before, change: changeOf(r.amount_cents, before) };
  });
}
