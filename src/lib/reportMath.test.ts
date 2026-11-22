import { describe, expect, it } from "vitest";
import { changeOf, changeText, changeTone, formatPct, pctOf, previousRange, withComparison } from "./reportMath";

describe("pctOf", () => {
  it("is a share with one decimal and 0 for no total", () => {
    expect(pctOf(1, 3)).toBe(33.3);
    expect(pctOf(50, 200)).toBe(25);
    expect(pctOf(5, 0)).toBe(0);
    expect(pctOf(5, -1)).toBe(0);
    expect(pctOf(Number.NaN, 10)).toBe(0);
  });
  it("formats whole and fractional percents", () => {
    expect(formatPct(25)).toBe("25%");
    expect(formatPct(33.3)).toBe("33.3%");
    expect(formatPct(Number.NaN)).toBe("0%");
  });
});

describe("changeOf", () => {
  it("up, down and flat with the percent against the previous period", () => {
    expect(changeOf(150, 100)).toEqual({ delta: 50, pct: 50, dir: "up" });
    expect(changeOf(75, 100)).toEqual({ delta: -25, pct: -25, dir: "down" });
    expect(changeOf(100, 100)).toEqual({ delta: 0, pct: 0, dir: "flat" });
  });
  it("has no percent when there was nothing before, and 0 when there is nothing at all", () => {
    expect(changeOf(40, 0)).toEqual({ delta: 40, pct: null, dir: "up" });
    expect(changeOf(0, 0).pct).toBe(0);
    expect(changeOf(0, 100)).toEqual({ delta: -100, pct: -100, dir: "down" });
  });
  it("writes the change", () => {
    expect(changeText(changeOf(150, 100))).toBe("▲ 50%");
    expect(changeText(changeOf(92, 100))).toBe("▼ 8%");
    expect(changeText(changeOf(5, 0))).toBe("جديد");
    expect(changeText(changeOf(5, 5))).toBe("—");
  });
  it("colours up as good for sales and as bad for cancellations", () => {
    expect(changeTone(changeOf(2, 1))).toBe("good");
    expect(changeTone(changeOf(1, 2))).toBe("bad");
    expect(changeTone(changeOf(2, 1), false)).toBe("bad");
    expect(changeTone(changeOf(1, 2), false)).toBe("good");
    expect(changeTone(changeOf(1, 1), false)).toBe("neutral");
  });
});

describe("previousRange", () => {
  it("takes the stretch of the same length right before a period of a day or more", () => {
    const p = previousRange("2026-11-08T05:00:00.000Z", "2026-11-15T05:00:00.000Z");
    expect(p.startIso).toBe("2026-11-01T05:00:00.000Z");
    expect(p.endIso).toBe("2026-11-08T04:59:59.999Z");
  });
  it("compares part of a day with the same hours yesterday", () => {
    const p = previousRange("2026-11-15T05:00:00.000Z", "2026-11-15T14:00:00.000Z");
    expect(p).toEqual({ startIso: "2026-11-14T05:00:00.000Z", endIso: "2026-11-14T14:00:00.000Z" });
  });
});

describe("withComparison", () => {
  const rows = [
    { key: "a", label: "A", count: 3, amount_cents: 300 },
    { key: "b", label: "B", count: 1, amount_cents: 100 },
    { key: "c", label: "C", count: 0, amount_cents: 0 },
  ];
  it("adds the share and the change per key", () => {
    const out = withComparison(rows, [{ key: "a", label: "A", count: 2, amount_cents: 200 }]);
    expect(out[0]).toMatchObject({ share: 75, previous_cents: 200, change: { pct: 50, dir: "up" } });
    expect(out[1]).toMatchObject({ share: 25, previous_cents: 0, change: { pct: null, dir: "up" } });
    expect(out[2].share).toBe(0);
  });
  it("works without a previous period", () => {
    expect(withComparison(rows, null)[0].previous_cents).toBe(0);
    expect(withComparison([], null)).toEqual([]);
  });
});
