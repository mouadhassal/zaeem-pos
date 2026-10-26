import { describe, expect, it } from "vitest";
import { AUTO_LAYOUT, MIN_CARD_WIDTH_PX, menuGridLayout, normalizeProductsPerRow } from "./menuGridLayout";

describe("menuGridLayout", () => {
  it("auto keeps the original grid", () => {
    expect(menuGridLayout(0, 1000)).toEqual(AUTO_LAYOUT);
  });

  it("before the first measurement, falls back to auto", () => {
    expect(menuGridLayout(7, 0)).toEqual(AUTO_LAYOUT);
  });

  it("5 per row on a ~1000px grid looks like today's full-size cards", () => {
    const l = menuGridLayout(5, 1000);
    expect(l.columns).toBe(5);
    expect(l.density).toBe("regular");
    expect(l.glyphHeightPx).toBe(90);
  });

  it("7 per row on the same grid shrinks the cards to fit 7", () => {
    const l = menuGridLayout(7, 1000);
    expect(l.columns).toBe(7);
    expect(l.density).toBe("compact");
    expect(l.glyphHeightPx).toBeLessThan(90);
  });

  it("10 per row goes to the smallest card, and still fits 10 on a ~1000px grid", () => {
    const l = menuGridLayout(10, 1000);
    expect(l.columns).toBe(10);
    expect(l.density).toBe("mini");
  });

  it("a narrow screen shows fewer than asked instead of unreadable cards", () => {
    const width = 600;
    const l = menuGridLayout(10, width);
    expect(l.columns).toBeLessThan(10);
    const cols = l.columns ?? 1;
    const cardWidth = (width - l.gapPx * (cols - 1)) / cols;
    expect(cardWidth).toBeGreaterThanOrEqual(MIN_CARD_WIDTH_PX);
  });
});

describe("normalizeProductsPerRow", () => {
  it("accepts the picker's choices, stored as strings too", () => {
    expect(normalizeProductsPerRow(7)).toBe(7);
    expect(normalizeProductsPerRow("8")).toBe(8);
  });

  it("anything else is auto", () => {
    expect(normalizeProductsPerRow(null)).toBe(0);
    expect(normalizeProductsPerRow("abc")).toBe(0);
    expect(normalizeProductsPerRow(3)).toBe(0);
    expect(normalizeProductsPerRow(50)).toBe(0);
  });
});
