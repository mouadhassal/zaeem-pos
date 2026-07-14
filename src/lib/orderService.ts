import { getDb } from "../db";
import { sql } from "kysely";
import { printReceipt, printKitchenTicket, queuePrintJob } from "./printer";
import { logger } from "./logger";
import type { ReceiptData } from "./printer";
import type { OrderType as OrderTypeEnum } from "../stores/orderTypeStore";

export async function createOrder(
  tableId: string,
  userId: string,
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
  driverId?: string
): Promise<string> {
  const db = await getDb();
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  const totalWithTax = subtotalCents + taxCents + secondaryTaxCents + serviceChargeCents - discountCents;

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("orders")
      .values({
        id: orderId,
        table_id: tableId,
        user_id: userId,
        status: "PENDING",
        order_type: orderType,
        subtotal_cents: subtotalCents,
        tax_cents: taxCents + secondaryTaxCents + serviceChargeCents,
        total_cents: Math.max(0, totalWithTax),
        discount_cents: discountCents,
        discount_reason: discountReason || null,
        customer_name: customerName || null,
        customer_phone: customerPhone || null,
        delivery_address: deliveryAddress || null,
        delivery_fee_cents: 0,
        driver_id: driverId || null,
        shift_id: shiftId || null,
        created_at: now,
        sync_version: 1,
        last_modified: now,
        sync_status: "pending",
      })
      .execute();

    for (const item of items) {
      const orderItemId = crypto.randomUUID();
      await trx
        .insertInto("order_items")
        .values({
          id: orderItemId,
          order_id: orderId,
          menu_item_id: item.menuItemId,
          quantity: item.quantity,
          unit_price_cents: item.unitPriceCents,
          notes: item.notes || null,
          combo_id: item.comboId || null,
          voided: 0,
          sync_version: 1,
          last_modified: now,
          sync_status: "pending",
        })
        .execute();

      if (item.modifiers) {
        for (const mod of item.modifiers) {
          await trx
            .insertInto("order_modifiers")
            .values({
              id: crypto.randomUUID(),
              order_item_id: orderItemId,
              name: mod.name,
              price_cents: mod.priceCents,
              sync_version: 1,
              last_modified: now,
              sync_status: "pending",
            })
            .execute();
        }
      }
    }

    await trx
      .updateTable("tables")
      .set({ status: "OCCUPIED", current_order_id: orderId, last_modified: now, sync_status: "pending" })
      .where("id", "=", tableId)
      .execute();
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
      await printKitchenTicket({
        tableName: (await db.selectFrom("tables").select("name").where("id", "=", tableId).executeTakeFirst())?.name ?? "",
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

export async function finalizeOrder(
  orderId: string,
  paymentMethod: string,
  amountCents: number,
  changeCents: number,
  receiptData: ReceiptData,
  debtorId?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("orders")
      .set({ status: "PAID", closed_at: now, last_modified: now, sync_status: "pending" })
      .where("id", "=", orderId)
      .execute();

    await trx
      .insertInto("payments")
      .values({
        id: crypto.randomUUID(),
        order_id: orderId,
        method: paymentMethod as any,
        amount_cents: amountCents,
        change_cents: changeCents,
        created_at: now,
        sync_version: 1,
        last_modified: now,
        sync_status: "pending",
      })
      .execute();

    await trx
      .updateTable("tables")
      .set({ status: "FREE", current_order_id: null, last_modified: now, sync_status: "pending" })
      .where("current_order_id", "=", orderId)
      .execute();

    if (debtorId) {
      await trx
        .insertInto("debt_entries")
        .values({
          id: crypto.randomUUID(),
          debtor_id: debtorId,
          order_id: orderId,
          amount_cents: amountCents,
          type: "DEBT",
          notes: null,
          created_by: "pos",
          created_at: now,
          sync_version: 1,
          last_modified: now,
          sync_status: "pending",
        })
        .execute();
      await trx
        .updateTable("debtors")
        .set({
          total_debt_cents: sql`total_debt_cents + ${amountCents}`,
          balance_cents: sql`balance_cents + ${amountCents}`,
          last_transaction_at: now,
          last_modified: now,
        })
        .where("id", "=", debtorId)
        .execute();
    }
  });

  try {
    await printReceipt(receiptData);
  } catch (err) {
    logger.error("Receipt print failed, queued for retry", { error: String(err) });
    queuePrintJob(receiptData, "receipt");
  }
}

export async function holdOrder(
  tableId: string,
  userId: string,
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
  const db = await getDb();
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("orders")
      .values({
        id: orderId,
        table_id: tableId,
        user_id: userId,
        status: "DRAFT",
        order_type: orderType,
        subtotal_cents: subtotalCents,
        tax_cents: taxCents,
        total_cents: totalCents,
        discount_cents: 0,
        delivery_fee_cents: 0,
        shift_id: shiftId || null,
        created_at: now,
        sync_version: 1,
        last_modified: now,
        sync_status: "pending",
      })
      .execute();

    for (const item of items) {
      const orderItemId = crypto.randomUUID();
      await trx
        .insertInto("order_items")
        .values({
          id: orderItemId,
          order_id: orderId,
          menu_item_id: item.menuItemId,
          quantity: item.quantity,
          unit_price_cents: item.unitPriceCents,
          notes: item.notes || null,
          voided: 0,
          sync_version: 1,
          last_modified: now,
          sync_status: "pending",
        })
        .execute();

      if (item.modifiers) {
        for (const mod of item.modifiers) {
          await trx
            .insertInto("order_modifiers")
            .values({
              id: crypto.randomUUID(),
              order_item_id: orderItemId,
              name: mod.name,
              price_cents: mod.priceCents,
              sync_version: 1,
              last_modified: now,
              sync_status: "pending",
            })
            .execute();
        }
      }
    }

    await trx
      .updateTable("tables")
      .set({ status: "OCCUPIED", current_order_id: orderId, last_modified: now, sync_status: "pending" })
      .where("id", "=", tableId)
      .execute();
  });

  return orderId;
}

export async function retrieveHeldOrder(
  orderId: string
): Promise<{
  items: {
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
  const db = await getDb();

  const order = await db
    .selectFrom("orders")
    .selectAll()
    .where("id", "=", orderId)
    .where("status", "=", "DRAFT")
    .executeTakeFirst();

  if (!order) return null;

  const orderItems = await db
    .selectFrom("order_items")
    .selectAll()
    .where("order_id", "=", orderId)
    .execute();

  const items = [];
  for (const oi of orderItems) {
    if (oi.voided) continue;

    const modifiers = await db
      .selectFrom("order_modifiers")
      .select(["name", "price_cents"])
      .where("order_item_id", "=", oi.id)
      .execute();

    const menuItem = await db
      .selectFrom("menu_items")
      .select("name")
      .where("id", "=", oi.menu_item_id)
      .executeTakeFirst();

    items.push({
      menuItemId: oi.menu_item_id,
      name: menuItem?.name ?? "",
      quantity: oi.quantity,
      unitPriceCents: oi.unit_price_cents,
      notes: oi.notes ?? "",
      modifiers: modifiers.map((m) => ({
        name: m.name,
        priceCents: m.price_cents,
      })),
    });
  }

  const ret: {
    items: { menuItemId: string; name: string; quantity: number; unitPriceCents: number; notes: string; modifiers: { name: string; priceCents: number }[] }[];
    customerName?: string; customerPhone?: string; deliveryAddress?: string;
  } = { items };
  if (order.customer_name) ret.customerName = order.customer_name;
  if (order.customer_phone) ret.customerPhone = order.customer_phone;
  if (order.delivery_address) ret.deliveryAddress = order.delivery_address;
  return ret;
}

export async function splitBill(
  orderId: string,
  splits: { itemIds: string[]; amountCents: number; label: string }[],
  userId: string,
  tableId: string
): Promise<string[]> {
  const db = await getDb();
  const now = new Date().toISOString();
  const splitOrderIds: string[] = [];

  await db.transaction().execute(async (trx) => {
    for (const split of splits) {
      const newOrderId = crypto.randomUUID();
      splitOrderIds.push(newOrderId);

      await trx
        .insertInto("orders")
        .values({
          id: newOrderId,
          table_id: tableId,
          user_id: userId,
          status: "PENDING",
          order_type: "DINE_IN",
          subtotal_cents: split.amountCents,
          tax_cents: 0,
          total_cents: split.amountCents,
          discount_cents: 0,
          delivery_fee_cents: 0,
          parent_order_id: orderId,
          created_at: now,
          sync_version: 1,
          last_modified: now,
          sync_status: "pending",
        })
        .execute();

      for (const itemId of split.itemIds) {
        await trx
          .updateTable("order_items")
          .set({ order_id: newOrderId, last_modified: now, sync_status: "pending" })
          .where("id", "=", itemId)
          .where("order_id", "=", orderId)
          .execute();
      }
    }
  });

  return splitOrderIds;
}

export async function mergeTables(
  sourceTableIds: string[],
  targetTableId: string,
  _userId: string
): Promise<string | null> {
  const db = await getDb();
  const now = new Date().toISOString();
  const mergeGroupId = crypto.randomUUID();

  let targetOrderId: string | null = null;

  await db.transaction().execute(async (trx) => {
    for (const tableId of sourceTableIds) {
      const table = await trx
        .selectFrom("tables")
        .selectAll()
        .where("id", "=", tableId)
        .executeTakeFirst();

      if (!table) continue;

      if (table.id === targetTableId) {
        await trx
          .updateTable("tables")
          .set({ status: "MERGED", merge_group_id: mergeGroupId, last_modified: now, sync_status: "pending" })
          .where("id", "=", tableId)
          .execute();
        targetOrderId = table.current_order_id;
      } else {
        await trx
          .updateTable("tables")
          .set({ status: "MERGED", merge_group_id: mergeGroupId, last_modified: now, sync_status: "pending" })
          .where("id", "=", tableId)
          .execute();

        if (table.current_order_id) {
          await trx
            .updateTable("order_items")
            .set({ order_id: targetOrderId!, last_modified: now, sync_status: "pending" })
            .where("order_id", "=", table.current_order_id)
            .execute();

          await trx
            .updateTable("orders")
            .set({ status: "CANCELLED", last_modified: now, sync_status: "pending" })
            .where("id", "=", table.current_order_id)
            .execute();
        }
      }
    }
  });

  return targetOrderId;
}

export async function unmergeTables(mergeGroupId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("tables")
      .set({ status: "FREE", merge_group_id: null, last_modified: now, sync_status: "pending" })
      .where("merge_group_id", "=", mergeGroupId)
      .execute();
  });
}

export async function voidOrderItem(
  itemId: string,
  reason: string,
  _managerPin?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("order_items")
      .set({ voided: 1, void_reason: reason, last_modified: now, sync_status: "pending" })
      .where("id", "=", itemId)
      .execute();
  });
}

export async function transferOrder(
  orderId: string,
  fromTableId: string,
  toTableId: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("orders")
      .set({ table_id: toTableId, last_modified: now, sync_status: "pending" })
      .where("id", "=", orderId)
      .execute();

    await trx
      .updateTable("tables")
      .set({ status: "FREE", current_order_id: null, last_modified: now, sync_status: "pending" })
      .where("id", "=", fromTableId)
      .execute();

    await trx
      .updateTable("tables")
      .set({ status: "OCCUPIED", current_order_id: orderId, last_modified: now, sync_status: "pending" })
      .where("id", "=", toTableId)
      .execute();
  });
}

export async function scheduleDelayedOrder(
  tableId: string,
  userId: string,
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
  const db = await getDb();
  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("orders")
      .values({
        id: orderId,
        table_id: tableId,
        user_id: userId,
        status: "SCHEDULED",
        order_type: orderType,
        subtotal_cents: subtotalCents,
        tax_cents: taxCents,
        total_cents: totalCents,
          discount_cents: 0,
          delivery_fee_cents: 0,
          scheduled_at: scheduledAt,
          created_at: now,
        sync_version: 1,
        last_modified: now,
        sync_status: "pending",
      })
      .execute();

    for (const item of items) {
      const orderItemId = crypto.randomUUID();
      await trx
        .insertInto("order_items")
        .values({
          id: orderItemId,
          order_id: orderId,
          menu_item_id: item.menuItemId,
          quantity: item.quantity,
          unit_price_cents: item.unitPriceCents,
          notes: item.notes || null,
          voided: 0,
          sync_version: 1,
          last_modified: now,
          sync_status: "pending",
        })
        .execute();
    }

    await trx
      .insertInto("delayed_orders")
      .values({
        id: crypto.randomUUID(),
        order_id: orderId,
        scheduled_at: scheduledAt,
        activated: 0,
        sync_version: 1,
        last_modified: now,
        sync_status: "pending",
      })
      .execute();
  });

  return orderId;
}

export async function activateDelayedOrders(): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  const due = await db
    .selectFrom("delayed_orders")
    .selectAll()
    .where("activated", "=", 0)
    .where("scheduled_at", "<=", now)
    .execute();

  for (const d of due) {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("orders")
        .set({ status: "PENDING", last_modified: now, sync_status: "pending" })
        .where("id", "=", d.order_id)
        .execute();

      await trx
        .updateTable("delayed_orders")
        .set({ activated: 1, last_modified: now, sync_status: "pending" })
        .where("id", "=", d.id)
        .execute();
    });

    const order = await db
      .selectFrom("orders")
      .selectAll()
      .where("id", "=", d.order_id)
      .executeTakeFirst();

    if (order) {
      const items = await db
        .selectFrom("order_items")
        .selectAll()
        .where("order_id", "=", d.order_id)
        .execute();

      try {
        const menuItemIds = items.map((i) => i.menu_item_id);
        const menuItemNames = menuItemIds.length > 0
          ? await db.selectFrom("menu_items").select(["id", "name"]).where("id", "in", menuItemIds).execute()
          : [];
        const nameMap = new Map(menuItemNames.map((m) => [m.id, m.name]));
        const tableRow = await db.selectFrom("tables").select("name").where("id", "=", order.table_id).executeTakeFirst();

        const delayedKitchenItems = items.map((i) => {
          const ki: { name: string; quantity: number; notes?: string } = { name: nameMap.get(i.menu_item_id) ?? "", quantity: i.quantity };
          if (i.notes) ki.notes = i.notes;
          return ki;
        });
        const kt: { tableName: string; orderNumber: string; orderType: OrderTypeEnum; items: { name: string; quantity: number; notes?: string }[]; scheduledAt?: string } = {
          tableName: tableRow?.name ?? "",
          orderNumber: order.id.slice(0, 8),
          orderType: order.order_type as OrderTypeEnum,
          items: delayedKitchenItems,
        };
        if (order.scheduled_at) kt.scheduledAt = order.scheduled_at;
        await printKitchenTicket(kt);
      } catch (err) {
        logger.error("Delayed order kitchen print failed", { error: String(err), orderId: order.id });
      }
    }
  }
}
