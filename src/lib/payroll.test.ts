import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  absenceCost,
  dayPay,
  describeLateRule,
  earlyCost,
  exampleLines,
  lateCost,
  monthLabel,
  muldiv,
  overtimePay,
  shiftMonth,
  type PayrollSettings,
} from "./payroll";

const S = (over: Partial<PayrollSettings>): PayrollSettings => ({ ...DEFAULT_SETTINGS, configured: true, ...over });

// These are the very numbers src-tauri/src/payroll.rs asserts in its own tests
// (a 780,000 monthly salary, 26 working days, an 8-hour day). If a formula is
// changed in one place and not the other, one of the two suites fails.
describe("payroll examples match the Rust engine", () => {
  it("a day's pay is the salary over the working days", () => {
    expect(dayPay(780_000, DEFAULT_SETTINGS)).toBe(30_000);
  });

  it("lateness: per minute, from the start or past the grace, fixed, tiers", () => {
    expect(lateCost(20, 780_000, S({ late_rule: "PER_MINUTE" }))).toBe(1_250);
    expect(lateCost(20, 780_000, S({ late_rule: "PER_MINUTE", late_counts_from_start: false }))).toBe(625);
    expect(lateCost(5, 780_000, S({ late_rule: "PER_MINUTE" }))).toBe(0);
    expect(lateCost(20, 780_000, S({ late_rule: "FIXED_PER_LATE", late_fixed_cents: 5_000 }))).toBe(5_000);
    const tiers = S({ late_rule: "TIERS", late_tiers: [{ from_minutes: 15, day_pct: 25 }, { from_minutes: 60, day_pct: 100 }] });
    expect(lateCost(20, 780_000, tiers)).toBe(7_500);
    expect(lateCost(60, 780_000, tiers)).toBe(30_000);
    expect(lateCost(20, 780_000, DEFAULT_SETTINGS)).toBe(0);
  });

  it("absence, leaving early and overtime", () => {
    expect(absenceCost(1, 780_000, S({ absence_rule: "DAY_PAY", absence_multiplier_pct: 200 }))).toBe(60_000);
    expect(absenceCost(2, 780_000, S({ absence_rule: "FIXED", absence_fixed_cents: 1_000 }))).toBe(2_000);
    expect(earlyCost(60, 780_000, S({ early_rule: "PER_MINUTE" }))).toBe(3_750);
    expect(overtimePay(330, 780_000, S({ overtime_rule: "PER_HOUR", overtime_multiplier_pct: 150 }))).toBe(30_938);
  });

  it("rounds half up like the engine", () => {
    expect(muldiv(1, 1, 2)).toBe(1);
    expect(muldiv(30_000, 20, 480)).toBe(1_250);
    expect(muldiv(5, 0, 0)).toBe(0);
  });
});

describe("the setup's plain-language examples", () => {
  it("show only the rules the owner switched on", () => {
    expect(exampleLines(DEFAULT_SETTINGS, 780_000)).toHaveLength(1);
    const lines = exampleLines(S({ late_rule: "PER_MINUTE", absence_rule: "DAY_PAY", overtime_rule: "PER_HOUR" }), 780_000);
    expect(lines.map((l) => l.label)).toEqual([
      "أجر اليوم لراتب شهري 780,000", "تأخر 20 دقيقة", "تأخر ساعة", "غاب يوماً", "عمل ساعتين إضافيتين",
    ]);
    expect(lines.find((l) => l.label === "غاب يوماً")?.amount).toBe(-30_000);
  });

  it("describe the chosen late rule", () => {
    expect(describeLateRule(DEFAULT_SETTINGS)).toBe("لا خصم على التأخير");
    expect(describeLateRule(S({ late_rule: "TIERS", late_tiers: [{ from_minutes: 15, day_pct: 25 }] }))).toContain("من 15 دقيقة 25%");
  });
});

describe("months", () => {
  it("move across years and have Arabic names", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-11")).toBe("تشرين الثاني 2026");
  });
});
