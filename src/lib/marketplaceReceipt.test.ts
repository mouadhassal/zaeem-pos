import { describe, it, expect } from "vitest";
import { buildReceiptLines, initialEdit, type PendingItem } from "./marketplaceReceipt";

const item = (id: string, over: Partial<PendingItem> = {}): PendingItem => ({
  order_item_id: id, product_name: "طحين", unit: "كيس 10 كجم", unit_size: 10, unit_measure: "kg", qty: 3,
  unit_price_cents: 400, line_total_cents: 1200, suggested_local_ingredient_id: "ing-1",
  suggested_ingredient_name: "طحين", suggested_stock_added: 30, ...over,
});

describe("buildReceiptLines", () => {
  it("defaults to the suggested mapping and converted stock", () => {
    expect(buildReceiptLines([item("a")], {})).toEqual([
      { order_item_id: "a", received_qty: 3, local_ingredient_id: "ing-1", stock_added: 30 },
    ]);
  });

  it("unmapped items are acknowledged without adding stock", () => {
    const i = item("b", { suggested_local_ingredient_id: null });
    expect(buildReceiptLines([i], { b: initialEdit(i) })).toEqual([
      { order_item_id: "b", received_qty: 3, local_ingredient_id: null, stock_added: null },
    ]);
  });

  it("rejects negative or non-numeric quantities", () => {
    expect(buildReceiptLines([item("c")], { c: { ingredientId: "ing-1", receivedQty: "-1", stockAdded: "3" } })).toBeNull();
    expect(buildReceiptLines([item("c")], { c: { ingredientId: "ing-1", receivedQty: "2", stockAdded: "abc" } })).toBeNull();
  });
});
