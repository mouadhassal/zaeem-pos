import { describe, expect, it } from "vitest";
import {
  amountFromText,
  formatWeight,
  gramsForAmount,
  gramsFromKgText,
  nameWithWeight,
  parseDecimal,
  priceForGrams,
  resolveWeighing,
} from "./weight";

// The same vectors as src-tauri/src/weighing.rs, so the till and the server round alike.
describe("weight maths matches the Rust side", () => {
  it("prices a weight, half rounded up", () => {
    expect(priceForGrams(120_000, 285)).toBe(34_200);
    expect(priceForGrams(120_000, 1000)).toBe(120_000);
    expect(priceForGrams(100_001, 1)).toBe(100);
    expect(priceForGrams(500, 1)).toBe(1);
    expect(priceForGrams(499, 1)).toBe(0);
  });

  it("turns an amount into the nearest gram", () => {
    expect(gramsForAmount(120_000, 10_000)).toBe(83);
    expect(gramsForAmount(120_000, 20_000)).toBe(167);
    expect(gramsForAmount(120_000, 120_000)).toBe(1000);
    expect(gramsForAmount(0, 10_000)).toBe(0);
    expect(gramsForAmount(120_000, 0)).toBe(0);
  });

  it("reads weights the way the server prints them", () => {
    expect(formatWeight(285)).toBe("285 غ");
    expect(formatWeight(1000)).toBe("1 كغ");
    expect(formatWeight(1250)).toBe("1.25 كغ");
    expect(formatWeight(2005)).toBe("2.005 كغ");
  });
});

describe("typing", () => {
  it("accepts Arabic digits and decimal marks", () => {
    expect(parseDecimal("٠٫٢٨٥")).toBe(0.285);
    expect(parseDecimal("0,285")).toBe(0.285);
    expect(parseDecimal("۱۰۰۰۰")).toBe(10000);
    expect(parseDecimal(".5")).toBe(0.5);
  });

  it("rejects anything that is not a plain number", () => {
    for (const bad of ["", ".", "abc", "1.2.3", "-5", "1e3", "١٢ك"]) expect(parseDecimal(bad), bad).toBeNull();
  });

  it("reads kilograms as whole grams without float drift", () => {
    expect(gramsFromKgText("0.285")).toBe(285);
    expect(gramsFromKgText("1.005")).toBe(1005);
    expect(gramsFromKgText("2")).toBe(2000);
    expect(gramsFromKgText("0.1")).toBe(100);
  });

  it("reads currency at its scale", () => {
    expect(amountFromText("10000", 0)).toBe(10_000);
    expect(amountFromText("12.5", 2)).toBe(1250);
  });
});

describe("resolveWeighing", () => {
  it("by weight: the server will price it, the till shows the same number", () => {
    const r = resolveWeighing("weight", "0.285", 120_000, 0);
    expect(r).toEqual({ ok: true, value: { grams: 285, lineCents: 34_200 } });
  });

  it("by amount: the customer pays exactly what they asked for", () => {
    const r = resolveWeighing("amount", "10000", 120_000, 0);
    expect(r).toEqual({ ok: true, value: { grams: 83, lineCents: 10_000, exactAmountCents: 10_000 } });
  });

  it("refuses what cannot be sold, in Arabic", () => {
    const refused = [
      resolveWeighing("weight", "0", 120_000, 0),
      resolveWeighing("weight", "abc", 120_000, 0),
      resolveWeighing("weight", "51", 120_000, 0),
      resolveWeighing("amount", "", 120_000, 0),
      resolveWeighing("amount", "50", 120_000, 0), // buys less than one gram
      resolveWeighing("weight", "1", 0, 0),
    ];
    for (const r of refused) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("nameWithWeight", () => {
  it("adds the weight to a weighed line only", () => {
    expect(nameWithWeight("شاورما", 285)).toBe("شاورما — 285 غ");
    expect(nameWithWeight("بطاطا", null)).toBe("بطاطا");
    expect(nameWithWeight("بطاطا", undefined)).toBe("بطاطا");
  });
});
