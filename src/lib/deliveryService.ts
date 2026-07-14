import { getDb } from "../db";
import { sql } from "kysely";
import type { DeliveryStatus } from "../db/types";

export interface DriverInput {
  name: string;
  phone: string;
  photo_path?: string;
  vehicle_type: "CAR" | "MOTORCYCLE" | "BIKE" | "VAN" | "TRUCK";
  vehicle_plate?: string;
  license_number?: string;
}

export interface ZoneInput {
  name: string;
  boundaries?: string;
  fee_cents: number;
  min_order_cents?: number;
  estimated_minutes?: number;
}

export async function getDrivers(includeInactive = false) {
  const db = await getDb();
  let query = db.selectFrom("drivers").selectAll().orderBy("name");
  if (!includeInactive) query = query.where("is_active", "=", 1);
  return query.execute();
}

export async function getAvailableDrivers() {
  const db = await getDb();
  return db
    .selectFrom("drivers")
    .selectAll()
    .where("status", "=", "AVAILABLE")
    .where("is_active", "=", 1)
    .orderBy("name")
    .execute();
}

export async function getDriver(id: string) {
  const db = await getDb();
  return db
    .selectFrom("drivers")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createDriver(input: DriverInput) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("drivers")
    .values({
      id,
      name: input.name,
      phone: input.phone,
      photo_path: input.photo_path || null,
      vehicle_type: input.vehicle_type,
      vehicle_plate: input.vehicle_plate || null,
      license_number: input.license_number || null,
      status: "AVAILABLE",
      total_deliveries: 0,
      rating: 5.0,
      is_active: 1,
      sync_version: 1,
      last_modified: now,
      sync_status: "pending",
    })
    .execute();
  return id;
}

export async function updateDriver(id: string, input: Record<string, unknown>) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .updateTable("drivers")
    .set({ ...input, last_modified: now, sync_status: "pending" } as any)
    .where("id", "=", id)
    .execute();
}

export async function deleteDriver(id: string) {
  const db = await getDb();
  await db
    .updateTable("drivers")
    .set({ is_active: 0, status: "INACTIVE", last_modified: new Date().toISOString(), sync_status: "pending" })
    .where("id", "=", id)
    .execute();
}

export async function assignDriver(orderId: string, driverId: string) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("delivery_logs")
      .values({
        id,
        order_id: orderId,
        driver_id: driverId,
        status: "ASSIGNED",
        assigned_at: now,
        sync_version: 1,
        last_modified: now,
        sync_status: "pending",
      })
      .execute();

    await trx
      .updateTable("orders")
      .set({ driver_id: driverId, last_modified: now, sync_status: "pending" })
      .where("id", "=", orderId)
      .execute();

    await trx
      .updateTable("drivers")
      .set({ status: "BUSY", last_modified: now, sync_status: "pending" })
      .where("id", "=", driverId)
      .execute();
  });
}

export async function updateDeliveryStatus(logId: string, status: DeliveryStatus, extra?: { failure_reason?: string; notes?: string }) {
  const db = await getDb();
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status, last_modified: now, sync_status: "pending" };

  if (status === "PICKED_UP") updates.picked_up_at = now;
  if (status === "DELIVERED") updates.delivered_at = now;
  if (status === "FAILED") {
    updates.failed_at = now;
    if (extra?.failure_reason) updates.failure_reason = extra.failure_reason;
  }
  if (extra?.notes) updates.notes = extra.notes;

  await db.transaction().execute(async (trx) => {
    const log = await trx
      .updateTable("delivery_logs")
      .set(updates)
      .where("id", "=", logId)
      .returning(["driver_id", "order_id"])
      .executeTakeFirst();

    if (log && (status === "DELIVERED" || status === "FAILED" || status === "CANCELLED")) {
      await trx
        .updateTable("drivers")
        .set({ status: "AVAILABLE", total_deliveries: status === "DELIVERED" ? sql`total_deliveries + 1` : sql`total_deliveries`, last_modified: now, sync_status: "pending" })
        .where("id", "=", log.driver_id)
        .execute();
    }
  });
}

export async function getActiveDeliveries() {
  const db = await getDb();
  return db
    .selectFrom("delivery_logs")
    .innerJoin("orders", "orders.id", "delivery_logs.order_id")
    .innerJoin("drivers", "drivers.id", "delivery_logs.driver_id")
    .select([
      "delivery_logs.id as log_id",
      "delivery_logs.status as delivery_status",
      "delivery_logs.assigned_at",
      "delivery_logs.picked_up_at",
      "orders.id as order_id",
      "orders.customer_name",
      "orders.customer_phone",
      "orders.delivery_address",
      "orders.total_cents",
      "drivers.id as driver_id",
      "drivers.name as driver_name",
      "drivers.phone as driver_phone",
      "drivers.vehicle_type",
      "drivers.vehicle_plate",
    ])
    .where("delivery_logs.status", "in", ["ASSIGNED", "PICKED_UP", "IN_TRANSIT"])
    .orderBy("delivery_logs.assigned_at", "desc")
    .execute();
}

export async function getDeliveryHistory(limit = 50, offset = 0) {
  const db = await getDb();
  return db
    .selectFrom("delivery_logs")
    .innerJoin("orders", "orders.id", "delivery_logs.order_id")
    .innerJoin("drivers", "drivers.id", "delivery_logs.driver_id")
    .select([
      "delivery_logs.id as log_id",
      "delivery_logs.status as delivery_status",
      "delivery_logs.assigned_at",
      "delivery_logs.delivered_at",
      "delivery_logs.failure_reason",
      "orders.id as order_id",
      "orders.customer_name",
      "orders.total_cents",
      "drivers.name as driver_name",
    ])
    .where("delivery_logs.status", "in", ["DELIVERED", "FAILED", "CANCELLED"])
    .orderBy("delivery_logs.assigned_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

export async function getZones() {
  const db = await getDb();
  return db.selectFrom("delivery_zones").selectAll().where("is_active", "=", 1).orderBy("name").execute();
}

export async function createZone(input: ZoneInput) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .insertInto("delivery_zones")
    .values({
      id,
      name: input.name,
      boundaries: input.boundaries || "[]",
      fee_cents: input.fee_cents,
      min_order_cents: input.min_order_cents || 0,
      estimated_minutes: input.estimated_minutes || 30,
      is_active: 1,
      sync_version: 1,
      last_modified: now,
      sync_status: "pending",
    })
    .execute();
  return id;
}

export async function updateZone(id: string, input: Partial<ZoneInput & { is_active: number }>) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .updateTable("delivery_zones")
    .set({ ...input, last_modified: now, sync_status: "pending" })
    .where("id", "=", id)
    .execute();
}

export async function deleteZone(id: string) {
  const db = await getDb();
  await db
    .updateTable("delivery_zones")
    .set({ is_active: 0, last_modified: new Date().toISOString(), sync_status: "pending" })
    .where("id", "=", id)
    .execute();
}

export async function getDriverDeliveries(driverId: string) {
  const db = await getDb();
  return db
    .selectFrom("delivery_logs")
    .innerJoin("orders", "orders.id", "delivery_logs.order_id")
    .select([
      "delivery_logs.id as log_id",
      "delivery_logs.status",
      "delivery_logs.assigned_at",
      "delivery_logs.delivered_at",
      "orders.customer_name",
      "orders.delivery_address",
      "orders.total_cents",
    ])
    .where("delivery_logs.driver_id", "=", driverId)
    .orderBy("delivery_logs.assigned_at", "desc")
    .limit(20)
    .execute();
}
