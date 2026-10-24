import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { printReceipt, printKitchenTicket, queuePrintJob } from "./printer";
import type { KitchenTicketData } from "./ticketLayout";
import { logger } from "./logger";
import type { ReceiptData } from "./printer";
import type { OrderType as OrderTypeEnum } from "../stores/orderTypeStore";
import { orderLabel } from "./orderLabels";

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
  comped?: boolean;
  comp_reason?: string | null;
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
  comped?: boolean;
  comp_reason?: string | null;
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
  customer_phone: string | null;
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

export interface BusinessMode {
  has_tables: boolean;
  has_kitchen: boolean;
}

// 2026-08-03 "next phase" (see nextphase.md §2): both default true, so an
// existing restaurant's experience is unchanged unless they opt out in
// Settings. Read on every POS/KDS/Settings load to decide what to show.
export async function getBusinessMode(): Promise<BusinessMode> {
  return invoke<BusinessMode>("get_business_mode_v3", { sessionToken: token() });
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

/** Who is logged in, for the "served by" line on kitchen slips and receipts. */
function cashierField(): { cashier?: string } {
  const name = useAuthStore.getState().user?.name;
  return name ? { cashier: name } : {};
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
    comped?: boolean;
    compReason?: string;
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
  managerOverridePin?: string,
  deliveryFeeCents = 0,
  /** Phone pickup: when the customer comes (epoch ms). The order waits unpaid in the pickup queue. */
  pickupAtMs?: number
): Promise<string> {
  // deliveryFeeCents folded into the charged total here -- previously
  // always 0 so this omission was invisible; now that a real zone fee can
  // flow through, leaving it out of the total would silently record the
  // fee without ever actually charging the customer for it.
  const totalWithTax = subtotalCents + taxCents + secondaryTaxCents + serviceChargeCents + deliveryFeeCents - discountCents;

  const inputItems: OrderItemInput[] = items.map((i) => ({
    menu_item_id: i.menuItemId,
    name: i.name ?? null,
    quantity: i.quantity,
    unit_price_cents: i.unitPriceCents,
    notes: i.notes ?? null,
    combo_id: i.comboId ?? null,
    modifiers: (i.modifiers ?? []).map((m) => ({ name: m.name, price_cents: m.priceCents })),
    comped: i.comped ?? false,
    comp_reason: i.compReason ?? null,
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
    deliveryFeeCents,
    shiftId: shiftId ?? null,
    // Re-verified server-side inside create_full_order_v3 (via
    // enforce_discount_cap) -- this is proof to Rust, not a trusted flag.
    managerOverridePin: managerOverridePin ?? null,
    pickupAtMs: pickupAtMs ?? null,
  });

  // A pickup reaches the kitchen through the pickup queue (now, or 20
  // minutes before a pickup that is still far away), never from here.
  if (pickupAtMs !== undefined) {
    await sendDuePickupsToKitchen();
    return orderId;
  }

  // 2026-08-03 "next phase" (see nextphase.md §2): a business with no
  // kitchen has nowhere to send this ticket at all -- skip the whole
  // flow rather than print/queue-retry something nobody will ever see.
  const { has_kitchen } = await getBusinessMode();
  if (!has_kitchen) return orderId;

  const kitchenItems = items.map((i) => {
    const ki: { name: string; quantity: number; notes?: string; modifiers?: string[]; menuItemId?: string } = {
      name: i.name ?? "", quantity: i.quantity,
    };
    if (i.menuItemId) ki.menuItemId = i.menuItemId;
    if (i.notes) ki.notes = i.notes;
    if (i.modifiers?.length) ki.modifiers = i.modifiers.map((m) => m.name);
    return ki;
  });

  const tables = await listTables();
  const tableName = tables.find((t) => t.id === tableId)?.name ?? "";
  const orderNumber = await orderLabel(orderId);
  try {
    await printKitchenTicket({
      tableName,
      orderNumber,
      orderType,
      items: kitchenItems,
      ...cashierField(),
      ...(customerName ? { customerName } : {}),
    });
  } catch (err) {
    // 2026-08-02: this used to fail completely silently -- logged only to
    // `logger.error` (console-only, invisible in a packaged build with no
    // devtools open) and queued for a background retry the cashier has no
    // way to know is even needed. Meanwhile the kitchen never sees the
    // order. `invoke`'s own wrapper already persists the underlying error
    // to the real Rust-side log for every failed command -- what was
    // actually missing is a VISIBLE signal, so the cashier can walk the
    // order to the kitchen by hand right now instead of discovering it
    // when a table asks where their food is.
    logger.error("Kitchen print failed, queued for retry", { error: String(err) });
    queuePrintJob(
      { tableName, orderNumber, orderType, items: kitchenItems },
      "kitchen"
    );
    window.dispatchEvent(
      new CustomEvent("kitchen-print-failed", {
        detail: { tableName, orderNumber, error: err instanceof Error ? err.message : String(err) },
      })
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
  cardNumber?: string,
  referenceCode?: string
): Promise<number | null> {
  const result = await invoke<FinalizePaymentResult>("finalize_order_with_payment_v3", {
    sessionToken: token(),
    orderId,
    method: paymentMethod,
    amountCents,
    changeCents,
    debtorId: debtorId ?? null,
    cardNumber: cardNumber ?? null,
    referenceCode: referenceCode ?? null,
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
    comped?: boolean;
    compReason?: string;
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
    comped: i.comped ?? false,
    comp_reason: i.compReason ?? null,
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
    comped: boolean;
    compReason: string;
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
      comped: !!i.comped,
      compReason: i.comp_reason ?? "",
    })),
    ...(result.customer_name ? { customerName: result.customer_name } : {}),
    ...(result.customer_phone ? { customerPhone: result.customer_phone } : {}),
    ...(result.delivery_address ? { deliveryAddress: result.delivery_address } : {}),
  };
}

interface PendingOrderSummary {
  id: string;
  total_cents: number;
  items: HeldOrderItem[];
}

// Split-bill payment queue resume (see pos/page.tsx's `PaymentModal
// onClose` comment): `split_bill` only ever points `tables.current_order_id`
// at the FIRST split order, so re-selecting a table can never reveal the
// rest -- this is the one query that can, scanning PENDING orders by
// `table_id` directly instead of following that pointer.
export async function listPendingOrdersForTable(tableId: string): Promise<{
  id: string;
  totalCents: number;
  items: { name: string; quantity: number; priceCents: number; modifiers: { name: string; priceCents: number }[]; comped: boolean; compReason: string }[];
}[]> {
  const rows = await invoke<PendingOrderSummary[]>("list_pending_orders_for_table_v3", {
    sessionToken: token(),
    tableId,
  });
  return rows.map((o) => ({
    id: o.id,
    totalCents: o.total_cents,
    items: o.items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      priceCents: i.unit_price_cents,
      modifiers: i.modifiers.map((m) => ({ name: m.name, priceCents: m.price_cents })),
      comped: !!i.comped,
      compReason: i.comp_reason ?? "",
    })),
  }));
}

interface OpenOrderApiResult {
  items: HeldOrderItem[];
  customer_name?: string | null;
  customer_phone?: string | null;
  delivery_address?: string | null;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  total_cents: number;
}

export interface OpenOrderResult {
  items: {
    dbItemId: string;
    menuItemId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    notes: string;
    modifiers: { name: string; priceCents: number }[];
    comped: boolean;
    compReason: string;
  }[];
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
}

/// "Send to kitchen now, pay later" dine-in fix: read back a table's OPEN
/// (already sent to the kitchen -- PENDING/PREPARING/READY/SERVED -- still
/// unpaid) order, the running-tab counterpart to `retrieveHeldOrder`'s
/// DRAFT-only read. Returns the order's REAL server-computed money totals
/// alongside its items -- `pos/page.tsx` uses `totalCents` as the
/// `totalOverrideCents` handed to `PaymentModal` (same pattern the
/// split-bill payment queue already uses) so the eventual
/// `finalize_order_with_payment_v3` call charges exactly what the order
/// record says, not a fresh client-side recompute that could drift.
export async function retrieveOpenOrder(orderId: string): Promise<OpenOrderResult | null> {
  const result = await invoke<OpenOrderApiResult | null>("retrieve_open_order_v3", {
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
      comped: !!i.comped,
      compReason: i.comp_reason ?? "",
    })),
    ...(result.customer_name ? { customerName: result.customer_name } : {}),
    ...(result.customer_phone ? { customerPhone: result.customer_phone } : {}),
    ...(result.delivery_address ? { deliveryAddress: result.delivery_address } : {}),
    subtotalCents: result.subtotal_cents,
    taxCents: result.tax_cents,
    discountCents: result.discount_cents,
    totalCents: result.total_cents,
  };
}

/// "Send to kitchen now, pay later" dine-in fix: appends more items to an
/// order that's already been sent to the kitchen and is still unpaid (a
/// real running tab), then fires a kitchen ticket containing ONLY these new
/// items -- never re-sends the items already on the order, so nothing the
/// kitchen is already cooking gets a duplicate ticket. Mirrors
/// `createOrder`'s own kitchen-ticket section below, minus the order
/// creation (the order already exists).
export async function addItemsToOrder(
  orderId: string,
  orderType: OrderTypeEnum,
  items: {
    menuItemId: string;
    name?: string;
    quantity: number;
    unitPriceCents: number;
    notes?: string;
    comboId?: string;
    modifiers?: { name: string; priceCents: number }[];
    comped?: boolean;
    compReason?: string;
  }[]
): Promise<void> {
  if (items.length === 0) return;

  const inputItems: OrderItemInput[] = items.map((i) => ({
    menu_item_id: i.menuItemId,
    name: i.name ?? null,
    quantity: i.quantity,
    unit_price_cents: i.unitPriceCents,
    notes: i.notes ?? null,
    combo_id: i.comboId ?? null,
    modifiers: (i.modifiers ?? []).map((m) => ({ name: m.name, price_cents: m.priceCents })),
    comped: i.comped ?? false,
    comp_reason: i.compReason ?? null,
  }));

  await invoke<void>("add_items_to_order_v3", {
    sessionToken: token(),
    orderId,
    items: inputItems,
  });

  const { has_kitchen } = await getBusinessMode();
  if (!has_kitchen) return;

  const kitchenItems = items.map((i) => {
    const ki: { name: string; quantity: number; notes?: string; modifiers?: string[]; menuItemId?: string } = {
      name: i.name ?? "", quantity: i.quantity,
    };
    if (i.menuItemId) ki.menuItemId = i.menuItemId;
    if (i.notes) ki.notes = i.notes;
    if (i.modifiers?.length) ki.modifiers = i.modifiers.map((m) => m.name);
    return ki;
  });

  const tables = await listTables();
  const tableName = tables.find((t) => t.current_order_id === orderId)?.name ?? "";
  const orderNumber = await orderLabel(orderId);
  try {
    await printKitchenTicket({
      tableName,
      orderNumber,
      orderType,
      items: kitchenItems,
      kind: "ADDITION",
      ...cashierField(),
    });
  } catch (err) {
    logger.error("Kitchen print failed (addition to open order), queued for retry", { error: String(err) });
    queuePrintJob(
      { tableName, orderNumber, orderType, items: kitchenItems, kind: "ADDITION", ...cashierField() },
      "kitchen"
    );
    window.dispatchEvent(
      new CustomEvent("kitchen-print-failed", {
        detail: { tableName, orderNumber, error: err instanceof Error ? err.message : String(err) },
      })
    );
  }
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

/**
 * Changes one line of an order that is already open: quantity, options and
 * kitchen note. The server voids the old line and adds the changed one, and
 * asks for a manager PIN when the change takes a lot of value off the bill.
 */
export async function editOrderItem(args: {
  itemId: string;
  quantity: number;
  modifiers: { name: string; priceCents: number }[];
  notes: string;
  reason: string;
  managerOverridePin?: string;
}): Promise<{ newItemId: string; orderTotalCents: number }> {
  const r = await invoke<{ new_item_id: string; order_total_cents: number }>("edit_order_item_v3", {
    sessionToken: token(),
    itemId: args.itemId,
    quantity: args.quantity,
    modifiers: args.modifiers.map((m) => ({ name: m.name, price_cents: m.priceCents })),
    notes: args.notes || null,
    reason: args.reason,
    managerOverridePin: args.managerOverridePin ?? null,
  });
  return { newItemId: r.new_item_id, orderTotalCents: r.order_total_cents };
}

/** Gives a line of an open order away ("on the house"), or takes the gift back. Returns the new order total. */
export async function setOrderItemComp(itemId: string, comped: boolean, reason?: string): Promise<number> {
  return invoke<number>("set_order_item_comp_v3", {
    sessionToken: token(),
    itemId,
    comped,
    reason: reason ?? null,
  });
}

/**
 * Tells the kitchen about a change to an order it already has (a cancelled
 * line, an edited line). Same failure handling as a new ticket: queued for
 * retry and announced, never silently dropped.
 */
export async function printKitchenChange(ticket: KitchenTicketData): Promise<void> {
  const { has_kitchen } = await getBusinessMode();
  if (!has_kitchen) return;
  const data: KitchenTicketData = { ...ticket, ...cashierField() };
  try {
    await printKitchenTicket(data);
  } catch (err) {
    logger.error("Kitchen print failed (change to open order), queued for retry", { error: String(err) });
    queuePrintJob(data, "kitchen");
    window.dispatchEvent(
      new CustomEvent("kitchen-print-failed", {
        detail: { tableName: data.tableName, orderNumber: data.orderNumber, error: err instanceof Error ? err.message : String(err) },
      })
    );
  }
}

export async function voidOrderItem(
  itemId: string,
  reason: string,
  managerOverridePin?: string
): Promise<void> {
  return invoke("void_order_item_v3", {
    sessionToken: token(),
    itemId,
    reason,
    managerOverridePin: managerOverridePin ?? null,
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
    comped?: boolean;
    compReason?: string;
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
    comped: i.comped ?? false,
    comp_reason: i.compReason ?? null,
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
    if (activatedIds.length === 0) return;
    // 2026-08-03 "next phase": same reasoning as createOrder's kitchen-
    // ticket skip -- checked once here, not per order, since this runs on
    // a 30s background timer.
    const { has_kitchen } = await getBusinessMode();
    if (!has_kitchen) return;
    for (const orderId of activatedIds) {
      try {
        const held = await retrieveHeldOrder(orderId);
        if (!held) continue;
        const tables = await listTables();
        const orderTableId = tables.find((t) => t.status === "OCCUPIED" && t.current_order_id === orderId)?.id;
        const tableName = orderTableId ? (tables.find((t) => t.id === orderTableId)?.name ?? "") : "";
        await printKitchenTicket({
          tableName,
          orderNumber: await orderLabel(orderId),
          orderType: "DINE_IN",
          items: held.items.map((i) => ({
            name: i.name, quantity: i.quantity,
            ...(i.menuItemId ? { menuItemId: i.menuItemId } : {}),
            ...(i.notes ? { notes: i.notes } : {}),
            ...(i.modifiers.length ? { modifiers: i.modifiers.map((m) => m.name) } : {}),
          })),
          ...cashierField(),
        });
      } catch (err) {
        // A scheduled order that just came due and silently never reached
        // the kitchen is at least as bad as the live-order case above --
        // this runs unattended on a 30s timer, so a toast is the only way
        // anyone finds out at all.
        logger.error("Delayed order kitchen print failed", { error: String(err), orderId });
        window.dispatchEvent(
          new CustomEvent("kitchen-print-failed", {
            detail: { orderNumber: await orderLabel(orderId), error: err instanceof Error ? err.message : String(err) },
          })
        );
      }
    }
  } catch (err) {
    // WENZDES audit L12: genuinely silent before -- no user toast is right
    // (this runs on a 30s background timer, not a user action), but a
    // real failure here (e.g. the DB call itself erroring) used to leave
    // no trace anywhere, not even the log. Logged now, still no UI noise.
    logger.error("activate_delayed_orders_v3 failed", { error: String(err) });
  }
}


// ---------------------------------------------------------------------------
// Pickup queue: phone orders the customer collects and pays for later.
// ---------------------------------------------------------------------------

export interface PickupOrder {
  order_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  pickup_at_ms: number;
  kitchen_at_ms: number;
  kitchen_sent: boolean;
  /** PENDING, PREPARING or READY. */
  kitchen_status: string;
  total_cents: number;
  created_at: string;
}

export interface PickupNoShow {
  order_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  pickup_at_ms: number;
  closed_at_ms: number;
  reason: string | null;
  by_name: string | null;
  total_cents: number;
}

export async function listPickupOrders(): Promise<PickupOrder[]> {
  return invoke<PickupOrder[]>("list_pickup_orders_v3", { sessionToken: token() });
}

/// Asks for every pickup whose kitchen time has come and prints its kitchen
/// slip. Safe to call from every till on a timer: each order is handed out
/// once, to whoever asks first.
export async function sendDuePickupsToKitchen(): Promise<void> {
  let due: PickupOrder[];
  try {
    due = await invoke<PickupOrder[]>("claim_due_pickup_kitchen_v3", { sessionToken: token() });
  } catch (err) {
    logger.error("claim_due_pickup_kitchen_v3 failed", { error: String(err) });
    return;
  }
  if (due.length === 0) return;
  const { has_kitchen } = await getBusinessMode();
  if (!has_kitchen) return;
  for (const p of due) {
    const ticket: KitchenTicketData = {
      tableName: "",
      orderNumber: await orderLabel(p.order_id),
      orderType: "TAKEAWAY",
      items: [],
      pickupAt: new Date(p.pickup_at_ms).toISOString(),
      createdAt: p.created_at,
      ...cashierField(),
      ...(p.customer_name ? { customerName: p.customer_name } : {}),
    };
    try {
      const open = await retrieveOpenOrder(p.order_id);
      if (!open) continue;
      ticket.items = open.items.map((i) => ({
        name: i.name, quantity: i.quantity, menuItemId: i.menuItemId,
        ...(i.notes ? { notes: i.notes } : {}),
        ...(i.modifiers.length ? { modifiers: i.modifiers.map((m) => m.name) } : {}),
      }));
      await printKitchenTicket(ticket);
    } catch (err) {
      // The order is already marked as sent, so a failed print must be
      // retried from the queue and shouted about, never dropped.
      logger.error("Pickup kitchen print failed, queued for retry", { error: String(err), orderId: p.order_id });
      if (ticket.items.length > 0) queuePrintJob(ticket, "kitchen");
      window.dispatchEvent(
        new CustomEvent("kitchen-print-failed", {
          detail: { orderNumber: ticket.orderNumber, error: err instanceof Error ? err.message : String(err) },
        })
      );
    }
  }
}

/// The customer came early: send a held-back order to the kitchen now.
export async function sendPickupToKitchenNow(orderId: string): Promise<void> {
  await invoke("send_pickup_to_kitchen_now_v3", { sessionToken: token(), orderId });
  await sendDuePickupsToKitchen();
}

/// The customer never came: cancels the unpaid order (a manager, or a manager's PIN, and a reason).
export async function markPickupNoShow(orderId: string, reason: string, managerOverridePin?: string): Promise<void> {
  await invoke("mark_pickup_no_show_v3", { sessionToken: token(), orderId, reason, managerOverridePin: managerOverridePin ?? null });
}

export async function listPickupNoShows(fromMs: number, toMs: number): Promise<PickupNoShow[]> {
  return invoke<PickupNoShow[]>("list_pickup_no_shows_v3", { sessionToken: token(), fromMs, toMs });
}
