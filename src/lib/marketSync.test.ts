import { describe, expect, it } from "vitest";
import { autoLine, autoReceiptLines, isPieceUnit } from "./marketSync";
import type { PendingItem, PendingOrder } from "./marketplaceReceipt";

const item = (over: Partial<PendingItem> = {}): PendingItem => ({
  order_item_id: "oi1", product_name: "طحين", unit: "كيس", unit_size: 10, unit_measure: "kg", qty: 3, unit_price_cents: 0, line_total_cents: 0,
  suggested_local_ingredient_id: null, suggested_ingredient_name: null, suggested_stock_added: null, ...over,
});
const order = (items: PendingItem[]): PendingOrder => ({ order_id: "o1", supplier_name: "مورد", delivered_at: null, total_cents: 0, note: null, items });

describe("automatic receiving", () => {
  it("takes in a confident kitchen-ingredient match with the converted stock", () => {
    const l = autoLine(item({ suggested_local_ingredient_id: "ing1", suggested_match_score: 0.9, suggested_stock_added: 30 }));
    expect(l).toMatchObject({ local_ingredient_id: "ing1", stock_added: 30, received_qty: 3 });
  });

  it("leaves a doubtful match for the owner", () => {
    expect(autoLine(item({ suggested_local_ingredient_id: "ing1", suggested_match_score: 0.5 }))).toBeNull();
    expect(autoLine(item())).toBeNull();
  });

  it("takes a same-name shop product only when it is bought by the piece", () => {
    const piece = autoLine(item({ unit: "قطعة", unit_size: null, suggested_local_menu_item_id: "p1" }));
    expect(piece).toMatchObject({ local_menu_item_id: "p1", stock_added: 3, local_ingredient_id: null });
    expect(autoLine(item({ unit: "كرتونة", unit_size: 12, suggested_local_menu_item_id: "p1" }))).toBeNull();
    expect(isPieceUnit("box", null)).toBe(false);
    expect(isPieceUnit("", null)).toBe(true);
  });

  it("an order is automatic only when every line is", () => {
    const good = item({ suggested_local_ingredient_id: "ing1", suggested_match_score: 1, suggested_stock_added: 30 });
    expect(autoReceiptLines(order([good, good]))).toHaveLength(2);
    expect(autoReceiptLines(order([good, item()]))).toBeNull();
    expect(autoReceiptLines(order([]))).toBeNull();
  });
});
