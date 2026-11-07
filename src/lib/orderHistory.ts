// Order history screen: one business day of orders, one order in full, a
// receipt printed again, and refunds. The rules live in Rust
// (src-tauri/src/order_history.rs, Repo::refund_order); a second till reads
// all of this from the main terminal.
import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { orderNo } from "./orderNumber";
import { printableShopName } from "./shopName";
import type { ReceiptData } from "./ticketLayout";
import type { RefundableLine } from "./refund";
import { billItemName, type Prefs } from "./prefs";

function token(): string {
  return useAuthStore.getState().token ?? "";
}

export interface HistoryRow {
  id: string;
  /** A-0001 style; null for an order from before daily numbers. */
  number: string | null;
  created_at: string;
  closed_at: string | null;
  order_type: string;
  status: string;
  table_name: string | null;
  cashier_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  item_count: number;
  total_cents: number;
  refunded_cents: number;
  payment_method: string | null;
  parent_order_id: string | null;
}

export interface HistoryDay {
  business_date: string;
  today: string;
  own_only: boolean;
  /** How many days before today this person may open (0 = today only). */
  back_days: number;
  rows: HistoryRow[];
}

export interface HistoryItem {
  id: string;
  name: string;
  category_name?: string | null;
  quantity: number;
  unit_price_cents: number;
  modifiers: { name: string; price_cents: number }[];
  notes: string | null;
  comped: boolean;
  comp_reason: string | null;
  refunded_quantity: number;
}

export interface HistoryRefund {
  id: string;
  amount_cents: number;
  reason: string | null;
  by_name: string | null;
  created_at: string;
  method: string | null;
  manager_pin_used: boolean;
  lines: { name: string; quantity: number }[];
}

export interface HistoryDetail extends HistoryRow {
  business_date: string | null;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  discount_reason: string | null;
  delivery_fee_cents: number;
  delivery_address: string | null;
  driver_name?: string | null;
  items: HistoryItem[];
  cancelled: { name: string; quantity: number; reason: string | null }[];
  payments: { method: string; amount_cents: number; change_cents: number; created_at: string; reference_code: string | null }[];
  refunds: HistoryRefund[];
}

export interface RefundOutcome {
  refund_id: string;
  amount_cents: number;
  method: string;
}

export const OPEN_STATUSES = ["PENDING", "PREPARING", "READY", "SERVED", "SCHEDULED"];

/** The number to show: the daily one, or the old short code. */
export function historyNumber(row: Pick<HistoryRow, "id" | "number">): string {
  return row.number ?? orderNo(row.id);
}

export function listOrderHistory(businessDate?: string): Promise<HistoryDay> {
  return invoke<HistoryDay>("list_order_history_v3", { sessionToken: token(), businessDate: businessDate ?? null });
}

export function getOrderHistoryDetail(orderId: string): Promise<HistoryDetail> {
  return invoke<HistoryDetail>("get_order_history_detail_v3", { sessionToken: token(), orderId });
}

/** `lines` null = the whole order. A cashier passes a manager PIN. */
export function refundOrder(
  orderId: string,
  reason: string,
  lines: { order_item_id: string; quantity: number }[] | null,
  managerOverridePin?: string,
  /** Shop goods that are fine go back on the shelf (only products whose stock is tracked). */
  restock = false,
): Promise<RefundOutcome> {
  return invoke<RefundOutcome>("refund_order_v3", {
    sessionToken: token(),
    orderId,
    reason,
    lines,
    managerOverridePin: managerOverridePin ?? null,
    restock,
  });
}

export function recordReceiptReprint(orderId: string): Promise<void> {
  return invoke<void>("record_receipt_reprint_v3", { sessionToken: token(), orderId });
}

/** The lines a refund can cover, in the shape refund.ts prices. */
export function refundableLines(d: HistoryDetail): RefundableLine[] {
  return d.items.map((i) => ({
    id: i.id,
    quantity: i.quantity,
    unitValueCents: i.unit_price_cents + i.modifiers.reduce((s, m) => s + m.price_cents, 0),
    refundedQuantity: i.refunded_quantity,
    comped: i.comped,
  }));
}

export interface HistoryAccess {
  /** 0 = a cashier sees today only; N = today and the N days before. */
  cashier_history_days: number;
  /** A cashier also sees what other staff took. */
  cashier_sees_all: boolean;
}

export function getHistoryAccess(): Promise<HistoryAccess> {
  return invoke<HistoryAccess>("get_history_access_v3", { sessionToken: token() });
}

export function saveHistoryAccess(access: HistoryAccess): Promise<void> {
  return invoke<void>("save_history_access_v3", { sessionToken: token(), access });
}

/**
 * The receipt as it was paid, with its own date, time, number and cashier, and any refund under the
 * total. Marked "copy" (and the time it was printed again) unless the owner turned that off.
 */
export function receiptFromHistory(
  d: HistoryDetail,
  cfg: { chain_name: string; branch_name: string; currency: string },
  prefs: Pick<Prefs, "reprintCopyMark" | "drinkLabelOn" | "drinkLabel" | "drinkCategories"> = { reprintCopyMark: true, drinkLabelOn: false, drinkLabel: "", drinkCategories: [] },
): ReceiptData {
  const pay = d.payments[0];
  const paidAt = d.closed_at ?? pay?.created_at;
  return {
    chainName: printableShopName(cfg.chain_name, cfg.branch_name),
    branchName: cfg.branch_name,
    currency: cfg.currency,
    orderNumber: historyNumber(d),
    tableName: d.table_name ?? "",
    orderType: d.order_type,
    items: d.items.map((i) => ({
      name: billItemName(i.name, i.category_name ?? "", prefs),
      quantity: i.quantity,
      priceCents: i.unit_price_cents,
      modifiers: i.modifiers.map((m) => ({ name: m.name, priceCents: m.price_cents })),
      ...(i.notes ? { notes: i.notes } : {}),
      ...(i.comped ? { comped: true, ...(i.comp_reason ? { compReason: i.comp_reason } : {}) } : {}),
    })),
    ...(d.cancelled.length ? { cancelledItems: d.cancelled.map((c) => ({ name: c.name, quantity: c.quantity, ...(c.reason ? { reason: c.reason } : {}) })) } : {}),
    // tax_cents already holds tax, second tax and service together.
    subtotalCents: d.subtotal_cents,
    taxCents: d.tax_cents,
    secondaryTaxCents: 0,
    serviceChargeCents: 0,
    discountCents: d.discount_cents,
    savingsCents: 0,
    totalCents: d.total_cents,
    paymentMethod: pay?.method ?? "",
    changeCents: pay?.change_cents ?? 0,
    ...(pay?.reference_code ? { referenceCode: pay.reference_code } : {}),
    ...(d.customer_name ? { customerName: d.customer_name } : {}),
    ...(d.customer_phone ? { customerPhone: d.customer_phone } : {}),
    ...(d.delivery_address ? { deliveryAddress: d.delivery_address } : {}),
    ...(d.delivery_fee_cents > 0 ? { deliveryFeeCents: d.delivery_fee_cents } : {}),
    ...(d.driver_name ? { driverName: d.driver_name } : {}),
    ...(d.cashier_name ? { cashier: d.cashier_name } : {}),
    createdAt: d.created_at,
    ...(paidAt ? { paidAt } : {}),
    ...(prefs.reprintCopyMark ? { isCopy: true } : {}),
    ...(d.refunded_cents > 0 ? { refundedCents: d.refunded_cents } : {}),
  };
}
