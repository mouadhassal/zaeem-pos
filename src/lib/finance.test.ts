import { describe, expect, it } from "vitest";
import { canonicalCategory, categoryHint, costClassLabel, EXPENSE_CATEGORIES, formatBp } from "./profit";
import { monthOf, monthRange, paymentMethodLabel, remainingText, rentPeriodLabel } from "./finance";

describe("expense categories", () => {
  it("has the 20 categories, rent and salaries among them", () => {
    expect(EXPENSE_CATEGORIES).toHaveLength(20);
    expect(EXPENSE_CATEGORIES).toContain("إيجار");
    expect(EXPENSE_CATEGORIES).toContain("وجبات موظفين");
  });
  it("shows old stored names under the new ones, and leaves the rest alone", () => {
    expect(canonicalCategory("إنترنت")).toBe("هاتف واتصالات");
    expect(canonicalCategory("صيانة")).toBe("صيانة وإصلاح");
    expect(canonicalCategory("تسويق")).toBe("دعاية وتسويق");
    expect(canonicalCategory("أخرى")).toBe("نثريات");
    expect(canonicalCategory("مشتريات من الموردين")).toBe("مشتريات مواد");
    expect(canonicalCategory("كهرباء")).toBe("كهرباء");
    expect(canonicalCategory("بند خاص")).toBe("بند خاص");
  });
  it("hints by the canonical name", () => {
    expect(categoryHint("مشتريات من الموردين")).toContain("لا تُحسب مرتين");
    expect(categoryHint("رواتب")).toContain("الرواتب");
    expect(categoryHint("أخرى")).toContain("مصروف جارٍ");
  });
});

describe("finance helpers", () => {
  it("labels", () => {
    expect(rentPeriodLabel("MONTHLY")).toBe("شهري");
    expect(paymentMethodLabel("TRANSFER")).toBe("تحويل");
    expect(paymentMethodLabel(null)).toBe("");
    expect(costClassLabel(null)).toBe("مأكولات");
    expect(costClassLabel("SHISHA")).toBe("أراجيل");
    expect(formatBp(3050)).toBe("30.5%");
  });
  it("months", () => {
    expect(monthOf("2026-11-22")).toBe("2026-11");
    expect(monthRange("2026-02")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(monthRange("2026-12")).toEqual(["2026-12-01", "2026-12-31"]);
  });
  it("remaining text", () => {
    const f = (c: number) => `${c}`;
    expect(remainingText(0, f)).toBe("مسدّد");
    expect(remainingText(300, f)).toBe("300");
    expect(remainingText(-50, f)).toBe("مدفوع مقدماً 50");
  });
});
