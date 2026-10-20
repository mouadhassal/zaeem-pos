import { describe, expect, it, vi } from "vitest";

vi.mock("./invoke", () => ({ invoke: async () => undefined }));

import { describePay, openForSettlement, settlementSummary, toCollectCents, type Delivery } from "./deliveryService";

const row = (over: Partial<Delivery> = {}): Delivery => ({
  order_id: "o1", created_at: "2026-10-20T12:00:00Z", status: "DELIVERED", address: "المزة", total_cents: 20_000, fee_cents: 2_000,
  pay_cents: 5_000, cash_due_cents: 20_000, pay_settled: false, cash_settled: false, driver_id: "d1", driver_name: "علي",
  customer_name: "أحمد", customer_phone: "0933", order_status: "PENDING", assigned_at: null, out_at: null, delivered_at: null, note: null, ...over,
});

describe("delivery helpers", () => {
  it("the driver collects nothing when the order was paid at the till", () => {
    expect(toCollectCents({ order_status: "PENDING", total_cents: 20_000 })).toBe(20_000);
    expect(toCollectCents({ order_status: "PAID", total_cents: 20_000 })).toBe(0);
  });

  it("reads the pay setting the way an owner would", () => {
    expect(describePay("PERCENT_OF_FEE", 50)).toBe("50% من رسوم التوصيل");
    expect(describePay("PER_DELIVERY", 5_000)).toContain("لكل توصيلة");
  });

  it("only delivered orders with something still open can be settled", () => {
    const rows = [
      row({ order_id: "open" }),
      row({ order_id: "done", pay_settled: true, cash_settled: true }),
      row({ order_id: "failed", status: "FAILED", pay_cents: 0, cash_due_cents: 0 }),
      row({ order_id: "out", status: "OUT" }),
      row({ order_id: "pay-only", order_status: "PAID", cash_due_cents: 0 }),
    ];
    expect(openForSettlement(rows).map((r) => r.order_id)).toEqual(["open", "pay-only"]);
  });

  it("adds up the cash to receive, the pay to hand over and the net", () => {
    const s = settlementSummary([row(), row({ order_id: "o2", total_cents: 30_000, cash_due_cents: 30_000 }), row({ order_id: "o3", order_status: "PAID", cash_due_cents: 0 })]);
    expect(s).toEqual({ count: 3, cash: 50_000, pay: 15_000, net: 35_000 });
  });

  it("does not count money already handed over", () => {
    const s = settlementSummary([row({ pay_settled: true, cash_settled: true })]);
    expect(s).toEqual({ count: 1, cash: 0, pay: 0, net: 0 });
  });
});
