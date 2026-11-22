// The numbers and rules behind the dashboard tabs (src/app/dashboard). Pure helpers only: no invoke, no DOM.
// A manager is not an accountant, so everything here ends in a few plain figures: a period, a change
// against the one before it (green or red), and which cards a person may see.
import { businessDayStart, businessPeriodStart } from "./businessDay";
import { PAGE_MODULE, moduleOn } from "./businessModules";
import { parseLocalDateStr } from "./dateLocal";
import { changeOf, changeText, changeTone, previousRange, type ChangeDir, type ChangeTone } from "./reportMath";

// ---------------------------------------------------------------- periods

export type DashPeriod = "today" | "week" | "month" | "year" | "custom";

export const DASH_PERIODS: { id: DashPeriod; label: string }[] = [
  { id: "today", label: "اليوم" },
  { id: "week", label: "هذا الأسبوع" },
  { id: "month", label: "هذا الشهر" },
  { id: "year", label: "هذه السنة" },
  { id: "custom", label: "فترة محددة" },
];

export interface DashRange {
  startIso: string;
  endIso: string;
}

export interface CustomDays {
  /** "YYYY-MM-DD", the first and last business day wanted. */
  start: string;
  end: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The business days of a period (they begin at 05:00, see businessDay.ts), up to now. */
export function periodRange(period: DashPeriod, now: Date = new Date(), custom?: CustomDays | null): DashRange {
  if (period === "custom" && custom && custom.start && custom.end) {
    let a = parseLocalDateStr(custom.start);
    let b = parseLocalDateStr(custom.end);
    if (a.getTime() > b.getTime()) [a, b] = [b, a];
    const start = businessDayStart(new Date(a.getFullYear(), a.getMonth(), a.getDate(), 12));
    // The last business day ends at 05:00 the next morning, but never later than now.
    const dayAfter = businessDayStart(new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1, 12));
    const end = new Date(Math.min(dayAfter.getTime() - 1, now.getTime()));
    return { startIso: start.toISOString(), endIso: new Date(Math.max(end.getTime(), start.getTime())).toISOString() };
  }
  const unit = period === "week" ? "week" : period === "month" ? "month" : period === "year" ? "year" : "day";
  return { startIso: businessPeriodStart(unit, now).toISOString(), endIso: now.toISOString() };
}

/**
 * What a period is compared with: today with the same hours yesterday, this week/month/year with the same
 * stretch of the one before (so "10 days into the month" meets the first 10 days of last month).
 */
export function previousPeriodRange(period: DashPeriod, range: DashRange): DashRange {
  const start = new Date(range.startIso);
  const end = new Date(range.endIso);
  if (period === "custom") return previousRange(range.startIso, range.endIso);
  const prevStart = new Date(start);
  if (period === "today") prevStart.setDate(prevStart.getDate() - 1);
  else if (period === "week") prevStart.setDate(prevStart.getDate() - 7);
  else if (period === "month") prevStart.setMonth(prevStart.getMonth() - 1);
  else prevStart.setFullYear(prevStart.getFullYear() - 1);
  const prevEnd = new Date(Math.min(prevStart.getTime() + (end.getTime() - start.getTime()), start.getTime() - 1));
  return { startIso: prevStart.toISOString(), endIso: prevEnd.toISOString() };
}

/** "2026-11" of the month a period ends in (payroll is worked out by the month). */
export function monthOfRange(range: DashRange): string {
  const d = new Date(range.endIso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "2026-01" -> "2025-12". */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Whether a period is a single day (the chart then shows hours, not days). */
export function isOneDay(range: DashRange): boolean {
  return new Date(range.endIso).getTime() - new Date(range.startIso).getTime() <= DAY_MS;
}

// ---------------------------------------------------------------- change against the period before

export interface ChangeView {
  text: string;
  tone: ChangeTone;
  dir: ChangeDir;
}

/** "▲ 12%" in green when sales went up; for costs pass `higherIsBetter = false`. */
export function moneyChange(current: number, previous: number, higherIsBetter = true): ChangeView {
  const c = changeOf(current, previous);
  let text = changeText(c);
  // A profit that was a loss before has no percent: say only which way it went.
  if (c.pct === null && previous < 0) text = c.dir === "up" ? "▲ أفضل" : "▼ أسوأ";
  return { text, tone: changeTone(c, higherIsBetter), dir: c.dir };
}

/** A share of sales (basis points: 3000 = 30%) changes in points, not in percent of a percent. */
export function pointsChange(currentBp: number, previousBp: number, higherIsBetter = false): ChangeView {
  const delta = Math.round((currentBp - previousBp) / 10) / 10;
  const dir: ChangeDir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const text = dir === "flat" ? "—" : `${dir === "up" ? "▲" : "▼"} ${Math.abs(delta)} نقطة`;
  const tone: ChangeTone = dir === "flat" ? "neutral" : (dir === "up") === higherIsBetter ? "good" : "bad";
  return { text, tone, dir };
}

// ---------------------------------------------------------------- which cards a person sees

export type DashTab = "summary" | "sales" | "finance" | "stock" | "hr";

export const DASH_TABS: { id: DashTab; label: string }[] = [
  { id: "summary", label: "الخلاصة" },
  { id: "sales", label: "المبيعات" },
  { id: "finance", label: "المالية" },
  { id: "stock", label: "المخزون" },
  { id: "hr", label: "الموظفين" },
];

export interface CardDef {
  id: string;
  tab: DashTab;
  /** The screen a tap opens (a sidebar page id) and, when it has tabs, the tab to land on. */
  page: string;
  target?: string;
  /** Only where the shop has a kitchen. */
  needsKitchen?: boolean;
}

export const CARD_DEFS: CardDef[] = [
  { id: "sales_today", tab: "summary", page: "reports", target: "sales" },
  { id: "profit_month", tab: "summary", page: "finance", target: "pnl" },
  { id: "cash_drawer", tab: "summary", page: "shift" },
  { id: "attn_stock", tab: "summary", page: "inventory", target: "alerts" },
  { id: "attn_debts", tab: "summary", page: "debt" },
  { id: "attn_late", tab: "summary", page: "reports", target: "kitchen", needsKitchen: true },

  { id: "s_sales", tab: "sales", page: "reports", target: "sales" },
  { id: "s_orders", tab: "sales", page: "reports", target: "sales" },
  { id: "s_avg", tab: "sales", page: "reports", target: "sales" },
  { id: "s_top", tab: "sales", page: "reports", target: "menu" },
  { id: "s_hour", tab: "sales", page: "reports", target: "sales" },
  { id: "s_discounts", tab: "sales", page: "reports", target: "sales" },

  { id: "f_sales", tab: "finance", page: "finance", target: "pnl" },
  { id: "f_cost", tab: "finance", page: "finance", target: "pnl" },
  { id: "f_labour", tab: "finance", page: "finance", target: "pnl" },
  { id: "f_expenses", tab: "finance", page: "finance", target: "costs" },
  { id: "f_profit", tab: "finance", page: "finance", target: "pnl" },

  { id: "k_value", tab: "stock", page: "inventory", target: "stock" },
  { id: "k_low", tab: "stock", page: "inventory", target: "alerts" },
  { id: "k_waste", tab: "stock", page: "inventory", target: "waste" },
  { id: "k_purchases", tab: "stock", page: "inventory", target: "purchases" },
  { id: "k_suppliers", tab: "stock", page: "inventory", target: "suppliers" },

  { id: "h_salaries", tab: "hr", page: "payroll", target: "month" },
  { id: "h_overtime", tab: "hr", page: "payroll", target: "month" },
  { id: "h_absence", tab: "hr", page: "staff", target: "attendance" },
  { id: "h_advances", tab: "hr", page: "payroll", target: "advances" },
  { id: "h_unpaid", tab: "hr", page: "payroll", target: "month" },
];

export function cardDef(id: string): CardDef {
  const def = CARD_DEFS.find((c) => c.id === id);
  if (!def) throw new Error(`unknown dashboard card ${id}`);
  return def;
}

export interface CardContext {
  /** The sidebar pages this person may open (role, the owner's access table and the plan already applied). */
  pages: ReadonlySet<string>;
  /** The modules the shop switched on; null = not loaded yet, everything counts as on. */
  modules: Record<string, boolean> | null | undefined;
  hasKitchen: boolean;
}

/** A card shows only when the person can open the screen it leads to, its module is on and the shop has what it needs. */
export function cardVisible(def: CardDef, ctx: CardContext): boolean {
  if (!ctx.pages.has(def.page)) return false;
  const module = PAGE_MODULE[def.page];
  if (module !== undefined && !moduleOn(ctx.modules, module)) return false;
  if (def.needsKitchen && !ctx.hasKitchen) return false;
  return true;
}

export function visibleCardIds(ctx: CardContext): Set<string> {
  return new Set(CARD_DEFS.filter((c) => cardVisible(c, ctx)).map((c) => c.id));
}

/** Tabs with at least one card the person can see. */
export function visibleTabs(ctx: CardContext): DashTab[] {
  const ids = visibleCardIds(ctx);
  return DASH_TABS.filter((t) => CARD_DEFS.some((c) => c.tab === t.id && ids.has(c.id))).map((t) => t.id);
}

// ---------------------------------------------------------------- charts

export interface BarPoint {
  label: string;
  value: number;
}

/** "2026-11-05" -> "5/11". */
function dayLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d}/${m}`;
}

/** Sales per day; a long period (a year) is added up by month so the bars stay readable. */
export function dayBars(trend: { date?: string; net_sales_cents: number }[]): BarPoint[] {
  const days = trend.filter((d) => d.date);
  if (days.length <= 62) return days.map((d) => ({ label: dayLabel(d.date!), value: d.net_sales_cents }));
  const byMonth = new Map<string, number>();
  for (const d of days) {
    const key = d.date!.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + d.net_sales_cents);
  }
  return [...byMonth.entries()].map(([key, value]) => ({ label: String(Number(key.slice(5))), value }));
}

/** Sales per hour of a single day, in the order of the hours. */
export function hourBars(rows: { key: string; label: string; amount_cents: number }[]): BarPoint[] {
  return [...rows].sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true })).map((r) => ({ label: r.label.slice(0, 2), value: r.amount_cents }));
}

/** The busiest hour: the row with the most sales (null when nothing was sold). */
export function busiestHour(rows: { label: string; amount_cents: number }[]): { label: string; amount_cents: number } | null {
  let best: { label: string; amount_cents: number } | null = null;
  for (const r of rows) if (r.amount_cents > 0 && (!best || r.amount_cents > best.amount_cents)) best = r;
  return best;
}

/** Heights of the bars as percent of the tallest (a bar with sales is never thinner than 3%). */
export function barHeights(points: BarPoint[]): number[] {
  const max = Math.max(0, ...points.map((p) => p.value));
  return points.map((p) => (max <= 0 || p.value <= 0 ? 0 : Math.max(3, Math.round((p.value / max) * 100))));
}

// ---------------------------------------------------------------- money, stock, people

export interface SplitProfit {
  net_sales_cents: number;
  cogs_cents: number;
  salaries_cents: number;
  operating_expenses_cents: number;
  net_profit_cents: number;
}

export interface SplitPart {
  id: "goods" | "salaries" | "other" | "profit";
  label: string;
  cents: number;
  /** Percent of sales, one decimal. */
  pct: number;
}

/** Where the sales went: the goods sold, salaries, other running costs, what stays. A loss leaves no "stays" part. */
export function moneySplit(p: SplitProfit): SplitPart[] {
  if (p.net_sales_cents <= 0) return [];
  const other = Math.max(0, p.operating_expenses_cents - p.salaries_cents);
  const parts: [SplitPart["id"], string, number][] = [
    ["goods", "ثمن ما بعته", p.cogs_cents],
    ["salaries", "رواتب", p.salaries_cents],
    ["other", "مصروفات أخرى", other],
    ["profit", "الباقي لك", Math.max(0, p.net_profit_cents)],
  ];
  return parts.filter(([, , cents]) => cents > 0).map(([id, label, cents]) => ({ id, label, cents, pct: Math.round((cents / p.net_sales_cents) * 1000) / 10 }));
}

/** Cost classes that cost something, in a fixed order (food, drinks, shisha, other); the screen names them with `costClassLabel`. */
export function classShares(classes: { class: string; cost_cents: number; bp: number }[]): { cls: string; bp: number }[] {
  const order = ["FOOD", "BEVERAGE", "SHISHA", "OTHER"];
  return [...classes]
    .filter((c) => c.cost_cents > 0)
    .sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class))
    .map((c) => ({ cls: c.class, bp: c.bp }));
}

/** 3333 -> "33.3%" (basis points). */
export function bpText(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** Ingredients at or under their alert level (those with an alert level only), the emptiest first. */
export function lowStockRows<T extends { on_hand: number; min_stock: number }>(rows: T[]): T[] {
  return rows
    .filter((r) => r.min_stock > 0 && r.on_hand <= r.min_stock)
    .sort((a, b) => a.on_hand / a.min_stock - b.on_hand / b.min_stock);
}

export interface HrSlip {
  absent_days: number;
  overtime_minutes: number;
  overtime_pay_cents: number;
}

export interface HrMonthRow {
  pay_set: boolean;
  earned_cents: number;
  status: string;
}

export interface HrTotals {
  salaries_cents: number;
  people: number;
  unpaid: number;
  absent_days: number;
  overtime_minutes: number;
  overtime_pay_cents: number;
}

/** The month of the staff added up: what they earned, who is not paid yet, absences and extra time. */
export function hrTotals(rows: HrMonthRow[], slips: HrSlip[]): HrTotals {
  const paid = rows.filter((r) => r.pay_set);
  return {
    salaries_cents: paid.reduce((s, r) => s + r.earned_cents, 0),
    people: paid.length,
    unpaid: paid.filter((r) => r.status !== "PAID").length,
    absent_days: slips.reduce((s, p) => s + p.absent_days, 0),
    overtime_minutes: slips.reduce((s, p) => s + p.overtime_minutes, 0),
    overtime_pay_cents: slips.reduce((s, p) => s + p.overtime_pay_cents, 0),
  };
}

/** 150 -> "2.5 ساعة", 60 -> "ساعة". */
export function hoursText(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  if (h === 1) return "ساعة";
  if (h === 2) return "ساعتان";
  return `${h} ساعة`;
}

/** Days of absence in words: 0 "لا غياب", 1 "يوم", 2 "يومان", 5 "5 أيام". */
export function daysText(days: number): string {
  if (days <= 0) return "لا غياب";
  if (days === 1) return "يوم";
  if (days === 2) return "يومان";
  return `${days} ${days <= 10 ? "أيام" : "يوماً"}`;
}
