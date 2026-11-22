import { describe, expect, it } from "vitest";
import { clampSettlement, invoiceTitle, openInvoices, previewGeneralPayment, type InvoiceLine } from "./credit";

const line = (id: string, remaining: number, over: Partial<InvoiceLine> = {}): InvoiceLine => ({
  entry_id: id, order_id: id, order_label: null, date: "2026-11-01", amount_cents: remaining, paid_cents: 0, remaining_cents: remaining, opening: false, ...over,
});

// The same numbers src-tauri/src/credit.rs asserts: invoices of 10,000 and 6,000 after a general payment.
describe("credit settlement helpers", () => {
  it("a general payment goes to the oldest open invoices first", () => {
    const lines = [line("a", 10_000), line("b", 6_000)];
    expect(previewGeneralPayment(lines, 12_000)).toEqual([{ entry_id: "a", take_cents: 10_000 }, { entry_id: "b", take_cents: 2_000 }]);
    expect(previewGeneralPayment(lines, 4_000)).toEqual([{ entry_id: "a", take_cents: 4_000 }]);
    expect(previewGeneralPayment(lines, 0)).toEqual([]);
  });

  it("an invoice that is already settled takes nothing", () => {
    const lines = [line("a", 0), line("b", 6_000)];
    expect(previewGeneralPayment(lines, 1_000)).toEqual([{ entry_id: "b", take_cents: 1_000 }]);
    expect(openInvoices(lines).map((l) => l.entry_id)).toEqual(["b"]);
  });

  it("a payment on one invoice is kept between nothing and what is left", () => {
    expect(clampSettlement(4_000, 3_000)).toBe(3_000);
    expect(clampSettlement(2_000, 3_000)).toBe(2_000);
    expect(clampSettlement(-5, 3_000)).toBe(0);
    expect(clampSettlement(Number.NaN, 3_000)).toBe(0);
  });

  it("invoices are named by their order number, the opening balance by what it is", () => {
    expect(invoiceTitle(line("a", 1, { order_label: "ص-12" }))).toBe("فاتورة ص-12");
    expect(invoiceTitle(line("a", 1))).toBe("فاتورة");
    expect(invoiceTitle(line("a", 1, { opening: true, order_id: null }))).toBe("رصيد سابق");
  });
});
