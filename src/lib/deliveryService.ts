import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "../stores/authStore";
import type { DeliveryStatus } from "../db/types";

function token() {
  return useAuthStore.getState().token;
}

export interface DriverInput {
  name: string;
  phone: string;
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
  return invoke(includeInactive ? "list_all_drivers_v3" : "list_drivers_v3", { sessionToken: token() });
}

export async function getAvailableDrivers() {
  return invoke("list_available_drivers_v3", { sessionToken: token() });
}

export async function createDriver(input: DriverInput) {
  return invoke<string>("create_driver_v3", {
    sessionToken: token(),
    name: input.name,
    phone: input.phone,
    vehicleType: input.vehicle_type,
    licenseNumber: input.license_number ?? null,
    vehiclePlate: input.vehicle_plate ?? null,
  });
}

export async function updateDriver(id: string, input: { name: string; phone?: string; vehicle_type: string; vehicle_plate?: string; license_number?: string }) {
  await invoke("update_driver_v3", {
    sessionToken: token(),
    driverId: id,
    name: input.name,
    phone: input.phone ?? null,
    vehicleType: input.vehicle_type,
    vehiclePlate: input.vehicle_plate ?? null,
    licenseNumber: input.license_number ?? null,
  });
}

export async function deleteDriver(id: string) {
  await invoke("deactivate_driver_v3", { sessionToken: token(), driverId: id });
}

/// Assignment atomicity (delivery_log created ASSIGNED + driver flips to
/// BUSY) is now one Rust transaction -- see Repo::assign_driver_to_delivery.
export async function assignDriver(orderId: string, driverId: string) {
  await invoke("assign_driver_to_delivery_v3", { sessionToken: token(), orderId, driverId });
}

/// `extra.notes` is dropped -- `delivery_logs` has no `notes` column in the
/// real schema (0001_init.sql); the old frontend silently no-opped it.
/// `failure_reason` is real and still passed through.
export async function updateDeliveryStatus(logId: string, status: DeliveryStatus, extra?: { failure_reason?: string }) {
  await invoke("update_delivery_status_and_driver_v3", {
    sessionToken: token(),
    deliveryLogId: logId,
    newStatus: status,
    failureReason: extra?.failure_reason ?? null,
  });
}

export async function getActiveDeliveries() {
  return invoke("list_active_deliveries_v3", { sessionToken: token() });
}

export async function getDeliveryHistory(limit = 50, offset = 0) {
  return invoke("list_delivery_history_v3", { sessionToken: token(), limit, offset });
}

export async function getZones() {
  return invoke("list_delivery_zones_v3", { sessionToken: token() });
}

export async function createZone(input: ZoneInput) {
  return invoke<string>("create_delivery_zone_v3", {
    sessionToken: token(),
    name: input.name,
    boundaries: input.boundaries ?? null,
    feeCents: input.fee_cents,
    minOrderCents: input.min_order_cents ?? 0,
    estimatedMinutes: input.estimated_minutes ?? 30,
  });
}

export async function updateZone(id: string, input: { name: string; fee_cents: number; min_order_cents?: number; estimated_minutes?: number }) {
  await invoke("update_delivery_zone_v3", {
    sessionToken: token(),
    zoneId: id,
    name: input.name,
    feeCents: input.fee_cents,
    minOrderCents: input.min_order_cents ?? 0,
    estimatedMinutes: input.estimated_minutes ?? 30,
  });
}

export async function deleteZone(id: string) {
  await invoke("deactivate_delivery_zone_v3", { sessionToken: token(), zoneId: id });
}

export async function getDriverDeliveries(driverId: string) {
  return invoke("list_driver_deliveries_v3", { sessionToken: token(), driverId });
}
