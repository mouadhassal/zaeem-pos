import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { printReceipt, printKitchenTicket, queuePrintJob } from "./printer";
import { logger } from "./logger";
import { autoSyncOrder } from "./sync";
import type { ReceiptData } from "./printer";
import type { OrderType as OrderTypeEnum } from "../stores/orderTypeStore";

function token(): string {
  return useAuthStore.getState().token ?? "";
}

interface OrderItemInput {
  menu_item_id: string;
  name?: string | null;
  quantity: number;
  unit_price_cents: number;
  notes?: string | null;
  combo_id?: string | null;
  modifiers: { name: string; price_cents: number }[];
}

interface HeldOrderModifier {
  name: string;
  price_cents: number;
}

interface HeldOrderItem {
  db_item_id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  notes: string;
  modifiers: HeldOrderModifier[];
}

export interface HeldOrderResult {
  items: HeldOrderItem[];
  customer_name?: string | null;
  customer_phone?: string | null;
  delivery_address?: string | null;
}

interface TableInfo {
  id: string;
  name: string;
  status: string;
  current_order_id?: string | null;
}

interface ReceiptConfig {
  chain_name: string;
  currency: string;
  branch_name: string;
}

interface LoyaltyCardLookup {
  card_number: string;
  customer_name: string;
  points: number;
  tier: string;
}

interface SplitBillInput {
  item_ids: string[];
  amount_cents: number;
  label: string;
}

export interface LoyaltyRewardOption {
  id: string;
  name: string;
  points_cost: number;
  reward_type: "FREE_ITEM" | "DISCOUNT_FIXED" | "DISCOUNT_PERCENT";
  value_cents: number | null;
  value_percent_bps: number | null;
  linked_menu_item_id: string | null;
  is_active: number;
}

export async function listTables(): Promise<TableInfo[]> {
  return invoke<TableInfo[]>("list_tables_v3", { sessionToken: token() });
}

export async function getReceiptConfig(): Promise<ReceiptConfig> {
  return invoke<ReceiptConfig>("get_receipt_config_v3", { sessionToken: token() });
}

export async function lookupLoyaltyCard(cardNumber: string): Promise<LoyaltyCardLookup | null> {
  return invoke<LoyaltyCardLookup | null>("lookup_loyalty_card_v3", { sessionToken: token(), cardNumber });
}

export async function listActiveLoyaltyRewards(): Promise<LoyaltyRewardOption[]> {
  const rows = await invoke<LoyaltyRewardOption[]>("list_loyalty_rewards_v3", { sessionToken: token() });
  return rows.filter((r) => r.is_active);
}

/// T2.0 loyalty: redeem points for a catalog reward at POS checkout.
/// Returns the applied reward so the caller can apply a matching manual
/// discount to the cart via the EXISTING discount mechanism -- redemption
/// itself is just the points ledger, not a cart mutation (see
/// `Repo::redeem_loyalty_reward`'s doc comment).
export async function redeemLoyaltyReward(cardNumber: string, rewardId: string): Promise<LoyaltyRewardOption> {
  return invoke<LoyaltyRewardOption>("redeem_loyalty_reward_v3", { sessionToken: token(), cardNumber, rewardId });
}

export async function createOrder(
  tableId: string,
  _userId: string,
  orderType: OrderTypeEnum,
  items: {
    menuItemId: string;
    name?: string;
    quantity: number;
    unitPriceCents: number;
    notes?: string;
    comboId?: string;
    modifiers?: { name: string; priceCents: number }[];
  }[],
  subtotalCents: number,
  taxCents: number,
  secondaryTaxCents: number,
  serviceChargeCents: number,
  _totalCents: number,
  discountCents: number,
  discountReason: string,
  customerName?: string,
  customerPhone?: string,
  deliveryAddress?: string,
  _savingsCents?: number,
  shiftId?: string,
  driverId?: string,
  managerOverridePin?: string
): Promise<string> {
  const totalWithTax = subtotalCents + taxCents + secondaryTaxCents + serviceChargeCents - discountCents;

  const inputItems: OrderItemInput[] = items.map((i) => ({
    menu_item_id: i.menuItemId,
    name: i.name ?? null,
    quantity: i.quantity,
    unit_price_cents: i.unitPriceCents,
    notes: i.notes ?? null,
    combo_id: i.comboId ?? null,
    modifiers: (i.modifiers ?? []).map((m) => ({ name: m.name, price_cents: m.priceCents })),
  }));

  const orderId = await invoke<string>("create_full_order_v3", {
    sessionToken: token(),
    tableId,
    orderType,
    items: inputItems,
    subtotalCents,
    taxCents: taxCents + secondaryTaxCents + serviceChargeCents,
    totalCents: Math.max(0, totalWithTax),
    discountCents,
    discountReason: discountReason || null,
    customerName: customerName ?? null,
    customerPhone: customerPhone ?? null,
    deliveryAddress: deliveryAddress ?? null,
    deliveryFeeCents: 0,
    driverId: driverId ?? null,
    shiftId: shiftId ?? null,
    // Re-verified server-side inside create_full_order_v3 (via
    // enforce_discount_cap) -- this is proof to Rust, not a trusted flag.
    managerOverridePin: managerOverridePin ?? null,
  });

  autoSyncOrder({
    id: orderId,
    type: orderType,
    status: "PENDING",
    totalCents: Math.max(0, totalWithTax),
    taxCents: taxCents + secondaryTaxCents + serviceChargeCents,
    items,
    customerName,
    customerPhone,
    deliveryAddress,
    tableId,
  });

  const kitchenItems = items.map((i) => {
    const ki: { name: string; quantity: number; notes?: string; modifiers?: string[] } = {
      name: i.name ?? "", quantity: i.quantity,
    };
    if (i.notes) ki.notes = i.notes;
    if (i.modifiers?.length) ki.modifiers = i.modifiers.map((m) => m.name);
    return ki;
  });

  try {
    const tables = await listTables();
    const tableName = tables.find((t) => t.id === tableId)?.name ?? "";
    await printKitchenTicket({
      tableName,
      orderNumber: orderId.slice(0, 8),
      orderType,
      items: kitchenItems,
    });
  } catch (err) {
    logger.error("Kitchen print failed, queued for retry", { error: String(err) });
    queuePrintJob(
      { tableName: "", orderNumber: orderId.slice(0, 8), orderType, items: kitchenItems },
      "kitchen"
    );
  }

  return orderId;
}

interface FinalizePaymentResult {
  payment_id: string;
  points_earned: number | null;
}

/// T2.0 loyalty: `cardNumber`, when passed, earns points ATOMICALLY inside
/// the same Rust transaction as the payment -- see
/// `Repo::finalize_order_with_payment`'s doc comment for why this replaced
/// a separate post-payment `earnLoyaltyPoints` call. Returns the points
/// earned (or `null` if no card was attached) so the caller can show it
/// without a second round trip.
export async function finalizeOrder(
  orderId: string,
  paymentMethod: string,
  amountCents: number,
  changeCents: number,
  receiptData: ReceiptData,
  debtorId?: string,
  cardNumber?: string
): Promise<number | null> {
  const result = await invoke<FinalizePaymentResult>("finalize_order_with_payment_v3", {
    sessionToken: token(),
    orderId,
    method: paymentMethod,
    amountCents,
    changeCents,
    debtorId: debtorId ?? null,
    cardNumber: cardNumber ?? null,
  });

  autoSyncOrder({
    id: orderId,
    type: receiptData.orderType || "DINE_IN",
    status: "paid",
    totalCents: receiptData.totalCents || 0,
    taxCents: receiptData.taxCents || 0,
    items: (receiptData.items || []).map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.priceCents,
    })),
  });

  try {
    await printReceipt(receiptData);
  } catch (err) {
    logger.error("Receipt print failed, queued for retry", { error: String(err) });
    queuePrintJob(receiptData, "receipt");
  }

  return result.points_earned;
}

export async function holdOrder(
  tableId: string,
  _userId: string,
  orderType: OrderTypeEnum,
  items: {
    menuItemId: string;
    quantity: number;
    unitPriceCents: number;
    notes?: string;
    modifiers?: { name: string; priceCents: number }[];
  }[],
  subtotalCents: number,
  taxCents: number,
  totalCents: number,
  shiftId?: string
): Promise<string> {
  const inputItems: OrderItemInput[] = items.map((i) => ({
    menu_item_id: i.menuItemId,
    name: null,
    quantity: i.quantity,
    unit_price_cents: i.unitPriceCents,
    notes: i.notes ?? null,
    combo_id: null,
    modifiers: (i.modifiers ?? []).map((m) => ({ name: m.name, price_cents: m.priceCents })),
  }));

  return invoke<string>("hold_order_v3", {
    sessionToken: token(),
    tableId,
    orderType,
    items: inputItems,
    subtotalCents,
    taxCents,
    totalCents,
    shiftId: shiftId ?? null,
  });
}

export async function retrieveHeldOrder(
  orderId: string
): Promise<{
  items: {
    dbItemId: string;
    menuItemId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    notes: string;
    modifiers: { name: string; priceCents: number }[];
  }[];
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
} | null> {
  const result = await invoke<HeldOrderResult | null>("retrieve_held_order_v3", {
    sessionToken: token(),
    orderId,
  });

  if (!result) return null;

  return {
    items: result.items.map((i) => ({
      dbItemId: i.db_item_id,
      menuItemId: i.menu_item_id,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      notes: i.notes,
      modifiers: i.modifiers.map((m) => ({ name: m.name, priceCents: m.price_cents })),
    })),
    ...(result.customer_name ? { customerName: result.customer_name } : {}),
    ...(result.customer_phone ? { customerPhone: result.customer_phone } : {}),
    ...(result.delivery_address ? { deliveryAddress: result.delivery_address } : {}),
  };
}

export async function splitBill(
  orderId: string,
  splits: { itemIds: string[]; amountCents: number; label: string }[],
  _userId: string,
  tableId: string
): Promise<string[]> {
  const inputSplits: SplitBillInput[] = splits.map((s) => ({
    item_ids: s.itemIds,
    amount_cents: s.amountCents,
    label: s.label,
  }));

  return invoke<string[]>("split_bill_v3", {
    sessionToken: token(),
    orderId,
    splits: inputSplits,
    tableId,
  });
}

export async function mergeTables(
  sourceTableIds: string[],
  targetTableId: string,
  _userId: string
): Promise<string | null> {
  return invoke<string | null>("merge_tables_v3", {
    sessionToken: token(),
    sourceTableIds,
    targetTableId,
  });
}

export async function unmergeTables(mergeGroupId: string): Promise<void> {
  return invoke("unmerge_tables_v3", {
    sessionToken: token(),
    mergeGroupId,
  });
}

export async function voidOrderItem(
  itemId: string,
  reason: string,
  _managerPin?: string
): Promise<void> {
  return invoke("void_order_item_v3", {
    sessionToken: token(),
    itemId,
    reason,
  });
}

export async function transferOrder(
  orderId: string,
  fromTableId: string,
  toTableId: string
): Promise<void> {
  return invoke("transfer_order_v3", {
    sessionToken: token(),
    orderId,
    fromTableId,
    toTableId,
  });
}

export async function scheduleDelayedOrder(
  tableId: string,
  _userId: string,
  orderType: OrderTypeEnum,
  items: {
    menuItemId: string;
    quantity: number;
    unitPriceCents: number;
    notes?: string;
    modifiers?: { name: string; priceCents: number }[];
  }[],
  subtotalCents: number,
  taxCents: number,
  totalCents: number,
  scheduledAt: string
): Promise<string> {
  const inputItems: OrderItemInput[] = items.map((i) => ({
    menu_item_id: i.menuItemId,
    name: null,
    quantity: i.quantity,
    unit_price_cents: i.unitPriceCents,
    notes: i.notes ?? null,
    combo_id: null,
    modifiers: (i.modifiers ?? []).map((m) => ({ name: m.name, price_cents: m.priceCents })),
  }));

  return invoke<string>("schedule_delayed_order_v3", {
    sessionToken: token(),
    tableId,
    orderType,
    items: inputItems,
    subtotalCents,
    taxCents,
    totalCents,
    scheduledAt,
  });
}

export async function activateDelayedOrders(): Promise<void> {
  try {
    const activatedIds = await invoke<string[]>("activate_delayed_orders_v3", {
      sessionToken: token(),
    });
    for (const orderId of activatedIds) {
      try {
        const held = await retrieveHeldOrder(orderId);
        if (!held) continue;
        const tables = await listTables();
        const orderTableId = tables.find((t) => t.status === "OCCUPIED" && t.current_order_id === orderId)?.id;
        await printKitchenTicket({
          tableName: orderTableId ? (tables.find((t) => t.id === orderTableId)?.name ?? "") : "",
          orderNumber: orderId.slice(0, 8),
          orderType: "DINE_IN",
          items: held.items.map((i) => ({ name: i.name, quantity: i.quantity, ...(i.notes ? { notes: i.notes } : {}) })),
        });
      } catch (err) {
        logger.error("Delayed order kitchen print failed", { error: String(err), orderId });
      }
    }
  } catch {
    // silent - timer-based, no user feedback needed
  }
}
