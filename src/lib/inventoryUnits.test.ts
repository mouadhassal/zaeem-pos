import { describe, expect, it } from "vitest";
import { batchCost, dayRangeIso, ymd, canonicalUnit, choiceFactor, stockValue, unitChoices, unitFactor, unitKind, unitLabel, yieldPct } from "./inventoryUnits";

describe("inventory units", () => {
  it("maps free text to standard codes and leaves unknown text alone", () => {
    expect(canonicalUnit("كغ")).toBe("kg");
    expect(canonicalUnit(" Kg ")).toBe("kg");
    expect(canonicalUnit("غرام")).toBe("g");
    expect(canonicalUnit("حبة")).toBe("piece");
    expect(canonicalUnit("علبة")).toBeNull();
    expect(unitLabel("kg")).toBe("كيلوغرام");
    expect(unitLabel("علبة")).toBe("علبة");
    expect(unitKind("ml")).toBe("VOLUME");
  });

  it("converts only inside one kind", () => {
    expect(unitFactor("g", "kg")).toBeCloseTo(0.001);
    expect(unitFactor("l", "ml")).toBe(1000);
    expect(unitFactor("g", "l")).toBeNull();
    expect(unitFactor("علبة", "علبة")).toBe(1);
    expect(unitFactor("علبة", "kg")).toBeNull();
  });

  it("offers the stock unit, same-kind units and the packs", () => {
    const choices = unitChoices("kg", [{ name_ar: "كرتونة", factor_to_stock_unit: 10 }]);
    expect(choices.map((c) => c.value)).toEqual(["", "g", "كرتونة"]);
    expect(choices[0].label).toBe("كيلوغرام");
    expect(unitChoices("علبة", []).map((c) => c.value)).toEqual([""]);
  });

  it("works out pack and unit factors for a line", () => {
    const packs = [{ name_ar: "كرتونة", factor_to_stock_unit: 10 }];
    expect(choiceFactor("", "kg", packs)).toBe(1);
    expect(choiceFactor("كرتونة", "kg", packs)).toBe(10);
    expect(choiceFactor("g", "kg", packs)).toBeCloseTo(0.001);
    expect(choiceFactor("l", "kg", packs)).toBeNull();
  });

  it("values stock at its average cost and ignores a negative balance", () => {
    expect(stockValue(17.35, 589)).toBe(10219);
    expect(stockValue(-3, 589)).toBe(0);
  });

  it("computes the yield percentage", () => {
    expect(yieldPct(20, 18)).toBe(90);
    expect(yieldPct(0, 5)).toBe(0);
  });

  it("costs a batch from its lines", () => {
    // 8000 g of tomato (kept in kg, 600 each) + 500 ml of oil (kept in l, 1000 each) = 4800 + 500
    expect(
      batchCost([
        { quantity: 8000, unit: "g", stockUnit: "kg", costCents: 600 },
        { quantity: 500, unit: "ml", stockUnit: "l", costCents: 1000 },
      ]),
    ).toBe(5300);
  });

  it("turns two days into a half-open range that includes the last day", () => {
    const [start, end] = dayRangeIso("2026-11-01", "2026-11-30");
    expect(new Date(end).getTime() - new Date(start).getTime()).toBeGreaterThanOrEqual(30 * 23 * 3600 * 1000);
    expect(ymd(new Date(start))).toBe("2026-11-01");
    expect(ymd(new Date(end))).toBe("2026-12-01");
  });
});
