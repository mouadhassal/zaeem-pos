// Payroll types and the small pure helpers the page uses. The real arithmetic
// is in src-tauri/src/payroll.rs; the "what would this rule cost?" examples
// the setup shows are worked out here with the same formulas, and
// payroll.test.ts pins them to the numbers payroll.rs's tests assert.

export type LateRule = "NONE" | "PER_MINUTE" | "FIXED_PER_LATE" | "TIERS";
export type AbsenceRule = "NONE" | "DAY_PAY" | "FIXED";
export type EarlyRule = "NONE" | "PER_MINUTE";
export type OvertimeRule = "NONE" | "PER_HOUR";
export type PayType = "MONTHLY" | "DAILY" | "HOURLY";

export interface LateTier {
  from_minutes: number;
  day_pct: number;
}

export interface PayrollSettings {
  configured: boolean;
  weekly_off_days: number[];
  days_per_month: number;
  shift_minutes: number;
  late_rule: LateRule;
  late_counts_from_start: boolean;
  late_multiplier_pct: number;
  late_fixed_cents: number;
  late_tiers: LateTier[];
  absence_rule: AbsenceRule;
  absence_multiplier_pct: number;
  absence_fixed_cents: number;
  early_rule: EarlyRule;
  early_multiplier_pct: number;
  overtime_rule: OvertimeRule;
  overtime_multiplier_pct: number;
  overtime_after_minutes: number;
  /** What a branch manager may do: the owner's choice. */
  manager_access: ManagerAccess;
}

export type ManagerAccess = "NONE" | "PREPARE" | "FULL";

/** What the signed-in person may do in payroll (the page shows or hides tabs and buttons by this). */
export interface PayrollAccess {
  is_owner: boolean;
  can_edit_rules: boolean;
  can_approve: boolean;
  manager_access: ManagerAccess;
}

export interface EmployeePay {
  user_id: string;
  pay_type: PayType;
  rate_cents: number;
  shift_start: string | null;
  shift_minutes: number | null;
  start_date: string | null;
  end_date: string | null;
  track_attendance: boolean;
}

export interface EmployeeRow {
  user_id: string;
  name: string;
  role: string;
  branch_id: string | null;
  pay: EmployeePay | null;
}

export interface AdjustmentRow {
  id: string;
  month: string;
  kind: "BONUS" | "FINE";
  amount_cents: number;
  reason: string;
  created_at: string;
}

export interface AdvanceRow {
  id: string;
  user_id: string;
  amount_cents: number;
  instalment_cents: number;
  repaid_cents: number;
  remaining_cents: number;
  given_on: string;
  reason: string | null;
}

export type DayStatus = "PRESENT" | "LATE" | "ABSENT" | "OFF" | "OFF_WORKED" | "PAID_LEAVE" | "MISSING_OUT" | "PENDING" | "NO_RECORD";

export interface DayLine {
  date: string;
  status: DayStatus;
  first_in: string | null;
  last_out: string | null;
  worked_minutes: number;
  late_minutes: number;
  early_minutes: number;
  overtime_minutes: number;
  note: string | null;
}

export interface Payslip {
  id: string | null;
  user_id: string;
  user_name: string;
  month: string;
  status: "DRAFT" | "APPROVED" | "PAID";
  pay_type: PayType;
  rate_cents: number;
  day_pay_cents: number;
  base_cents: number;
  late_days: number;
  late_minutes: number;
  late_deduction_cents: number;
  absent_days: number;
  absence_deduction_cents: number;
  early_minutes: number;
  early_deduction_cents: number;
  overtime_minutes: number;
  overtime_pay_cents: number;
  paid_leave_days: number;
  bonus_cents: number;
  fine_cents: number;
  earned_cents: number;
  advance_repaid_cents: number;
  net_cents: number;
  days: DayLine[];
  adjustments: AdjustmentRow[];
  warnings: string[];
  approved_at: string | null;
  paid_at: string | null;
}

export interface MonthRow {
  user_id: string;
  name: string;
  role: string;
  pay_set: boolean;
  pay_type: PayType | null;
  status: "NO_PAY" | "DRAFT" | "APPROVED" | "PAID";
  base_cents: number;
  deductions_cents: number;
  additions_cents: number;
  earned_cents: number;
  advance_repaid_cents: number;
  net_cents: number;
  warnings: number;
  payslip_id: string | null;
}

/** What a fresh install starts with: nothing is deducted until the owner chooses. */
export const DEFAULT_SETTINGS: PayrollSettings = {
  configured: false,
  weekly_off_days: [5],
  days_per_month: 26,
  shift_minutes: 480,
  late_rule: "NONE",
  late_counts_from_start: true,
  late_multiplier_pct: 100,
  late_fixed_cents: 0,
  late_tiers: [],
  absence_rule: "NONE",
  absence_multiplier_pct: 100,
  absence_fixed_cents: 0,
  early_rule: "NONE",
  early_multiplier_pct: 100,
  overtime_rule: "NONE",
  overtime_multiplier_pct: 150,
  overtime_after_minutes: 30,
  manager_access: "NONE",
};

export const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export const PAY_TYPE_LABEL: Record<PayType, string> = { MONTHLY: "راتب شهري", DAILY: "أجر يومي", HOURLY: "أجر بالساعة" };

export const PAY_TYPE_RATE_LABEL: Record<PayType, string> = { MONTHLY: "الراتب الشهري", DAILY: "أجر اليوم", HOURLY: "أجر الساعة" };

export const STATUS_LABEL: Record<MonthRow["status"], string> = {
  NO_PAY: "لم يُحدَّد راتبه",
  DRAFT: "مسودة",
  APPROVED: "معتمد",
  PAID: "مصروف",
};

export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  PRESENT: "حاضر",
  LATE: "متأخر",
  ABSENT: "غائب",
  OFF: "عطلة",
  OFF_WORKED: "عمل في العطلة",
  PAID_LEAVE: "عذر مقبول",
  MISSING_OUT: "بلا بصمة خروج",
  PENDING: "لم يأتِ بعد",
  NO_RECORD: "لا سجل",
};

/** "2026-11" for a date. */
export function monthOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** The month before/after, "2026-01" -> "2025-12". */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthOf(d);
}

const MONTH_NAMES = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
}

/** Integer round-half-up of a*b/c, as payroll.rs's `muldiv`. */
export function muldiv(a: number, b: number, c: number): number {
  if (c <= 0) return 0;
  return Math.floor((a * b + Math.floor(c / 2)) / c);
}

export interface ExampleInput {
  /** A monthly salary to work the examples on. */
  salary: number;
  settings: PayrollSettings;
}

export interface ExampleLine {
  label: string;
  /** The amount in currency units (whole pounds). */
  amount: number;
}

/** One day of pay for a monthly salary. */
export function dayPay(salary: number, settings: PayrollSettings): number {
  return muldiv(salary, 1, settings.days_per_month);
}

/** What arriving `minutes` late costs under the owner's late rule (the grace is the attendance setting, 10 by default). */
export function lateCost(minutes: number, salary: number, s: PayrollSettings, grace = 10): number {
  if (s.late_rule === "NONE" || minutes <= grace) return 0;
  const counted = s.late_counts_from_start ? minutes : minutes - grace;
  const day = dayPay(salary, s);
  switch (s.late_rule) {
    case "PER_MINUTE":
      return muldiv(muldiv(day, counted, s.shift_minutes), s.late_multiplier_pct, 100);
    case "FIXED_PER_LATE":
      return s.late_fixed_cents;
    case "TIERS": {
      const tier = [...s.late_tiers].reverse().find((t) => minutes >= t.from_minutes);
      return tier ? muldiv(day, tier.day_pct, 100) : 0;
    }
  }
}

export function absenceCost(days: number, salary: number, s: PayrollSettings): number {
  const day = dayPay(salary, s);
  if (s.absence_rule === "DAY_PAY") return muldiv(day * days, s.absence_multiplier_pct, 100);
  if (s.absence_rule === "FIXED") return s.absence_fixed_cents * days;
  return 0;
}

export function earlyCost(minutes: number, salary: number, s: PayrollSettings): number {
  if (s.early_rule !== "PER_MINUTE") return 0;
  return muldiv(muldiv(dayPay(salary, s), minutes, s.shift_minutes), s.early_multiplier_pct, 100);
}

export function overtimePay(minutes: number, salary: number, s: PayrollSettings): number {
  if (s.overtime_rule !== "PER_HOUR") return 0;
  return muldiv(muldiv(dayPay(salary, s), minutes, s.shift_minutes), s.overtime_multiplier_pct, 100);
}

/** Plain-language lines that show the owner what each of his rules does to a sample salary. */
export function exampleLines(s: PayrollSettings, salary: number): ExampleLine[] {
  const lines: ExampleLine[] = [{ label: "أجر اليوم لراتب شهري " + salary.toLocaleString("en-US"), amount: dayPay(salary, s) }];
  if (s.late_rule !== "NONE") {
    lines.push({ label: "تأخر 20 دقيقة", amount: -lateCost(20, salary, s) });
    lines.push({ label: "تأخر ساعة", amount: -lateCost(60, salary, s) });
  }
  if (s.absence_rule !== "NONE") lines.push({ label: "غاب يوماً", amount: -absenceCost(1, salary, s) });
  if (s.early_rule !== "NONE") lines.push({ label: "خرج قبل النهاية بساعة", amount: -earlyCost(60, salary, s) });
  if (s.overtime_rule !== "NONE") lines.push({ label: "عمل ساعتين إضافيتين", amount: overtimePay(120, salary, s) });
  return lines;
}

/** Human sentence for a rule, shown in the rules summary. */
export function describeLateRule(s: PayrollSettings): string {
  switch (s.late_rule) {
    case "NONE":
      return "لا خصم على التأخير";
    case "PER_MINUTE":
      return `يُخصم ${s.late_multiplier_pct === 100 ? "بقدر الوقت الضائع" : `${s.late_multiplier_pct}% من أجر الوقت الضائع`} بالدقيقة`;
    case "FIXED_PER_LATE":
      return `مبلغ ثابت ${s.late_fixed_cents.toLocaleString("en-US")} عن كل يوم تأخير`;
    case "TIERS":
      return "حسب الشرائح: " + s.late_tiers.map((t) => `من ${t.from_minutes} دقيقة ${t.day_pct}% من أجر اليوم`).join("، ");
  }
}

export function describeAbsenceRule(s: PayrollSettings): string {
  switch (s.absence_rule) {
    case "NONE":
      return "لا خصم على الغياب";
    case "DAY_PAY":
      return `يُخصم ${s.absence_multiplier_pct === 100 ? "أجر يوم" : `${s.absence_multiplier_pct}% من أجر اليوم`} عن كل غياب`;
    case "FIXED":
      return `مبلغ ثابت ${s.absence_fixed_cents.toLocaleString("en-US")} عن كل غياب`;
  }
}
