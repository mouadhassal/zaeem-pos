/**
 * The marketplace and the POS, kept together without the owner doing it by hand.
 *
 * Buying: an order that arrives from a supplier is added to the stock by itself when every line is
 * clearly the same thing as something in the shop (a kitchen ingredient matched by the marketplace, or a
 * product with the same name bought by the piece); anything uncertain is left for the owner and shown in
 * the bell. Selling (a supplier shop): see the "السوق" tab of the stock screen and `supplier_link.rs`.
 * Pure functions, unit-tested; the polling lives in `useMarketSync`.
 */
import type { PendingItem, PendingOrder, ReceiptLine } from "./marketplaceReceipt";

/** A kitchen-ingredient suggestion this sure is taken without asking. */
export const AUTO_MATCH_SCORE = 0.8;

const PIECE_UNITS = new Set(["", "piece", "pieces", "pcs", "pc", "unit", "قطعة", "قطع", "حبة", "وحدة"]);

/** Units a product counted in pieces can take as they are. */
export function isPieceUnit(unit: string | null | undefined, unitSize: number | null | undefined): boolean {
  const u = (unit ?? "").trim().toLowerCase();
  return PIECE_UNITS.has(u) && (unitSize == null || unitSize === 1);
}

/** The receipt line for an item when the match is certain enough to need no human; null when it needs one. */
export function autoLine(item: PendingItem): ReceiptLine | null {
  if (item.suggested_local_ingredient_id && (item.suggested_match_score ?? 0) >= AUTO_MATCH_SCORE) {
    return {
      order_item_id: item.order_item_id,
      received_qty: item.qty,
      local_ingredient_id: item.suggested_local_ingredient_id,
      stock_added: item.suggested_stock_added ?? item.qty,
    };
  }
  if (!item.suggested_local_ingredient_id && item.suggested_local_menu_item_id && isPieceUnit(item.unit, item.unit_size)) {
    return {
      order_item_id: item.order_item_id,
      received_qty: item.qty,
      local_ingredient_id: null,
      stock_added: item.qty,
      local_menu_item_id: item.suggested_local_menu_item_id,
    };
  }
  return null;
}

/** All the order's lines, when every one of them can be taken in automatically; otherwise null. */
export function autoReceiptLines(order: PendingOrder): ReceiptLine[] | null {
  if (order.items.length === 0) return null;
  const lines: ReceiptLine[] = [];
  for (const item of order.items) {
    const line = autoLine(item);
    if (!line) return null;
    lines.push(line);
  }
  return lines;
}

/** What the bell and the stock screen say about the marketplace. */
export interface MarketStatus {
  /** Goods that arrived and need the owner to match them with the stock. */
  receiptsToReview: number;
  /** A supplier's customer orders that wait because a product is not linked yet. */
  ordersNeedLinks: number;
  /** A supplier's orders taken out of the stock in the last round. */
  lastAppliedOrders: number;
  /** Goods taken into the stock by themselves in the last round. */
  lastAutoReceived: number;
  isSupplier: boolean;
  error: string | null;
}

export const EMPTY_MARKET_STATUS: MarketStatus = {
  receiptsToReview: 0,
  ordersNeedLinks: 0,
  lastAppliedOrders: 0,
  lastAutoReceived: 0,
  isSupplier: false,
  error: null,
};
