import { describe, expect, it } from "vitest";
import { refundAmount, refundPreview, type RefundableLine } from "./refund";

describe("refundAmount (same cases as the Rust refund_amount test)", () => {
  it("shares discount and tax and closes exactly", () => {
    // 3 lines of 1000, 10% discount, 500 delivery: paid 3200.
    expect(refundAmount(1000, 3000, 3200, 500, 0, false)).toBe(900);
    expect(refundAmount(1000, 3000, 3200, 500, 900, false)).toBe(900);
    expect(refundAmount(1000, 3000, 3200, 500, 1800, true)).toBe(1400);
    expect(refundAmount(1, 3, 100, 0, 0, false)).toBe(33);
    expect(refundAmount(2, 3, 100, 0, 0, false)).toBe(67);
    expect(refundAmount(2, 3, 100, 0, 90, false)).toBe(10);
    expect(refundAmount(0, 0, 100, 0, 0, false)).toBe(0);
  });
});

describe("refundPreview", () => {
  const lines: RefundableLine[] = [
    { id: "a", quantity: 2, unitValueCents: 1500, refundedQuantity: 0, comped: false },
    { id: "b", quantity: 1, unitValueCents: 1500, refundedQuantity: 0, comped: false },
    { id: "gift", quantity: 1, unitValueCents: 900, refundedQuantity: 0, comped: true },
  ];

  it("prices chosen lines by their share, ignoring gifts", () => {
    expect(refundPreview(lines, { a: 1 }, 4500, 0, 0)).toBe(1500);
    expect(refundPreview(lines, { gift: 1 }, 4500, 0, 0)).toBe(0);
  });

  it("the last lines take everything left; the whole order is what is left", () => {
    const after = lines.map((l) => (l.id === "a" ? { ...l, refundedQuantity: 1 } : l));
    expect(refundPreview(after, { a: 1, b: 1 }, 4500, 0, 1500)).toBe(3000);
    expect(refundPreview(after, "ALL", 4500, 0, 1500)).toBe(3000);
  });
});
