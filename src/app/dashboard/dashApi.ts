// The existing commands the dashboard tabs read. Nothing new on the Rust side: every number comes from the
// same command its detailed report uses, so the card and the report always agree.
import { invoke } from "../../lib/invoke";
import { useAuthStore } from "../../stores/authStore";
import { tzOffsetMinutes, type ProfitSummary, type DayProfit } from "../../lib/profit";
import type { DashRange } from "../../lib/dashboard";

export interface DashBranch {
  branch_id: string;
  branch_name: string;
  revenue_cents: number;
  order_count: number;
  costs_cents: number;
  profit_cents: number;
  avg_ticket_cents: number;
  profit: ProfitSummary;
}

export interface DashSummary {
  branches: DashBranch[];
  total_outstanding_debt_cents: number;
  total_outstanding_supplier_balance_cents: number;
  profit: ProfitSummary;
}

export interface CostOfSales {
  net_sales_cents: number;
  classes: { class: string; cost_cents: number; bp: number }[];
  total_cost_cents: number;
  total_bp: number;
  labour_cents: number;
  labour_bp: number;
}

export interface HourRow {
  key: string;
  label: string;
  count: number;
  amount_cents: number;
}

export interface StockRow {
  ingredient_id: string;
  name: string;
  unit: string;
  on_hand: number;
  min_stock: number;
}

export interface StockReport {
  rows: StockRow[];
  total_value_cents: number;
  waste_value_cents: number;
  received_value_cents: number;
}

export interface PayrollMonthRow {
  user_id: string;
  pay_set: boolean;
  earned_cents: number;
  status: string;
}

export interface PayslipLite {
  absent_days: number;
  overtime_minutes: number;
  overtime_pay_cents: number;
}

const token = () => useAuthStore.getState().token ?? "";

/** A part that could not be read (no permission, a module off, an old hub) comes back as null: its cards stay hidden. */
export async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export const getSummary = (r: DashRange) =>
  invoke<DashSummary>("get_dashboard_summary_v3", { sessionToken: token(), startIso: r.startIso, endIso: r.endIso, tzOffsetMinutes: tzOffsetMinutes() });

export const getTrend = (r: DashRange) =>
  invoke<DayProfit[]>("get_profit_trend_v3", { sessionToken: token(), startIso: r.startIso, endIso: r.endIso, tzOffsetMinutes: tzOffsetMinutes() });

export const getCostOfSales = (r: DashRange) =>
  invoke<CostOfSales>("get_cost_of_sales_v3", { sessionToken: token(), startIso: r.startIso, endIso: r.endIso, tzOffsetMinutes: tzOffsetMinutes() });

export const getHours = async (r: DashRange) =>
  (await invoke<{ rows: HourRow[] }>("get_sales_breakdown_v3", { sessionToken: token(), startIso: r.startIso, endIso: r.endIso, kind: "hour", tzOffsetMinutes: tzOffsetMinutes() })).rows;

export const getTopItems = async (r: DashRange) =>
  (await invoke<{ top_items: { name: string; quantity: number }[] }>("get_sales_report_v3", { sessionToken: token(), todayStartIso: r.startIso, rangeEndIso: r.endIso })).top_items;

export const getLateOrders = async (r: DashRange) =>
  (await invoke<{ prep: { late_count: number; late_minutes: number } }>("get_kitchen_delivery_report_v3", { sessionToken: token(), startIso: r.startIso, endIso: r.endIso, lateMinutes: null })).prep;

export const getStockReport = (r: DashRange) =>
  invoke<StockReport>("get_stock_report_v3", { sessionToken: token(), rangeStartIso: r.startIso, rangeEndIso: r.endIso });

/** What should be in the drawer of the shift the signed-in person has open, or null when none is open. */
export async function getDrawerCash(): Promise<number | null> {
  const shift = await invoke<{ id: string; starting_cash_cents: number } | null>("get_active_shift_v3", { sessionToken: token() });
  if (!shift) return null;
  const s = await invoke<{ cash_total: number; cash_refunds: number }>("get_shift_stats_v3", { sessionToken: token(), shiftId: shift.id });
  return shift.starting_cash_cents + s.cash_total - s.cash_refunds;
}

export const getPayrollMonth = (month: string) =>
  invoke<PayrollMonthRow[]>("payroll_month_v3", { sessionToken: token(), month, tzOffsetMinutes: tzOffsetMinutes() });

export const getPayslip = (userId: string, month: string) =>
  invoke<PayslipLite>("get_payslip_v3", { sessionToken: token(), userId, month, tzOffsetMinutes: tzOffsetMinutes() });

/** What staff still owe back on advances. */
export async function getAdvancesOutstanding(): Promise<number> {
  const rows = await invoke<{ remaining_cents: number }[]>("list_payroll_advances_v3", { sessionToken: token(), userId: null });
  return rows.reduce((s, a) => s + Math.max(0, a.remaining_cents), 0);
}
