import { describe, it, expect } from "vitest";
import { calculateTax, calculateComboSavings } from "./taxCalculator";

// Every sale on every terminal runs through this -- a rounding or mode
// mistake here is a real-money error repeated on every order, not a
// cosmetic bug. These lock down both tax modes plus the discount/rounding
// edge cases that are easy to get wrong.
describe("calculateTax", () => {
  const exclusive = { mode: "exclusive" as const, taxRateCents: 1500, secondaryTaxRateCents: 0, serviceChargeRateCents: 0 };
  const inclusive = { mode: "inclusive" as const, taxRateCents: 1500, secondaryTaxRateCents: 0, serviceChargeRateCents: 0 };

  it("exclusive mode adds tax on top of the item total", () => {
    // 15% of 10000 = 1500
    const result = calculateTax(10_000, 0, exclusive);
    expect(result.subtotalCents).toBe(10_000);
    expect(result.taxCents).toBe(1_500);
    expect(result.totalCents).toBe(11_500);
  });

  it("inclusive mode backs the tax out of the item total instead of adding it", () => {
    // 11500 already contains 15% tax: subtotal = 11500 / 1.15 = 10000
    const result = calculateTax(11_500, 0, inclusive);
    expect(result.subtotalCents).toBe(10_000);
    expect(result.taxCents).toBe(1_500);
    expect(result.totalCents).toBe(11_500);
  });

  it("applies the discount before computing tax, not after", () => {
    // A discount changes the taxable base -- taxing the pre-discount total
    // would overcharge tax on money the customer never actually paid.
    const result = calculateTax(10_000, 2_000, exclusive);
    expect(result.subtotalCents).toBe(8_000);
    expect(result.taxCents).toBe(1_200);
    expect(result.totalCents).toBe(9_200);
  });

  it("clamps a discount larger than the item total to zero instead of going negative", () => {
    const result = calculateTax(5_000, 9_000, exclusive);
    expect(result.subtotalCents).toBe(0);
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(0);
  });

  it("stacks secondary tax and service charge on the exclusive subtotal", () => {
    const config = { mode: "exclusive" as const, taxRateCents: 1000, secondaryTaxRateCents: 500, serviceChargeRateCents: 1000 };
    const result = calculateTax(10_000, 0, config);
    expect(result.taxCents).toBe(1_000);
    expect(result.secondaryTaxCents).toBe(500);
    expect(result.serviceChargeCents).toBe(1_000);
    expect(result.totalCents).toBe(12_500);
  });

  it("charges zero tax when the rate is zero", () => {
    const result = calculateTax(10_000, 0, { mode: "exclusive", taxRateCents: 0, secondaryTaxRateCents: 0, serviceChargeRateCents: 0 });
    expect(result.taxCents).toBe(0);
    expect(result.totalCents).toBe(10_000);
  });
});

describe("calculateComboSavings", () => {
  it("returns the difference when the bundle is cheaper", () => {
    expect(calculateComboSavings(10_000, 8_000)).toBe(2_000);
  });

  it("clamps to zero when the bundle isn't actually cheaper", () => {
    // A misconfigured combo priced above the sum of its parts must never
    // display a negative "savings" figure to the cashier.
    expect(calculateComboSavings(8_000, 10_000)).toBe(0);
  });

  it("returns zero when the prices are equal", () => {
    expect(calculateComboSavings(5_000, 5_000)).toBe(0);
  });
});
