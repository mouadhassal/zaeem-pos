// Goods received from the WENZDES Marketplace (ECOSYSTEM_CONTRACTS.md 6).
// Types mirror src-tauri/src/goods_receipt.rs.

export interface PendingItem {
  order_item_id: string;
  product_name: string;
  unit: string | null;
  unit_size: number | null;
  unit_measure: string | null;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
  suggested_local_ingredient_id: string | null;
  suggested_ingredient_name: string | null;
  suggested_stock_added: number | null;
}

export interface PendingOrder {
  order_id: string;
  supplier_name: string | null;
  delivered_at: string | null;
  total_cents: number;
  note: string | null;
  items: PendingItem[];
}

export interface PendingReceipts {
  orders: PendingOrder[];
}

export interface LineEdit {
  ingredientId: string;
  receivedQty: string;
  stockAdded: string;
}

export interface ReceiptLine {
  order_item_id: string;
  received_qty: number;
  local_ingredient_id: string | null;
  stock_added: number | null;
}

export function initialEdit(item: PendingItem): LineEdit {
  return {
    ingredientId: item.suggested_local_ingredient_id ?? "",
    receivedQty: String(item.qty),
    stockAdded: String(item.suggested_stock_added ?? item.qty),
  };
}

// Builds p_lines; an unmapped item is still acknowledged but adds no stock.
// Returns null when any number is invalid.
export function buildReceiptLines(items: PendingItem[], edits: Record<string, LineEdit>): ReceiptLine[] | null {
  const lines: ReceiptLine[] = [];
  for (const item of items) {
    const e = edits[item.order_item_id] ?? initialEdit(item);
    const received = Number(e.receivedQty);
    const added = e.ingredientId ? Number(e.stockAdded) : null;
    if (!Number.isFinite(received) || received < 0) return null;
    if (added !== null && (!Number.isFinite(added) || added < 0)) return null;
    lines.push({
      order_item_id: item.order_item_id,
      received_qty: received,
      local_ingredient_id: e.ingredientId || null,
      stock_added: added,
    });
  }
  return lines;
}
