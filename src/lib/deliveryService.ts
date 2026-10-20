// Delivery: thin typed wrappers over the delivery commands, plus the few pure
// helpers the screens share. The rules (pay, cash, statuses) live in Rust
// (src-tauri/src/delivery.rs); nothing here decides money.

import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { formatMoney } from "./money";
import type { StatementLine, StatementTotals } from "./ticketLayout";

const token = () => useAuthStore.getState().token ?? "";

export type PayMode = "PER_DELIVERY" | "PERCENT_OF_FEE";

export interface DeliverySettings {
  pay_mode: PayMode;
  pay_value: number;
}

export interface Driver {
  id: string;
  name: string;
  phone: string | null;
  /** This driver's own rate (same unit as the pay mode), or null to use the default. */
  pay_value: number | null;
  is_active: boolean;
}

export type DeliveryStatus = "NEW" | "ASSIGNED" | "OUT" | "DELIVERED" | "FAILED";

export interface Delivery extends StatementLine {
  driver_id: string | null;
  driver_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  order_status: string;
  status: DeliveryStatus;
  assigned_at: string | null;
  out_at: string | null;
  delivered_at: string | null;
  note: string | null;
}

export interface Statement {
  driver: Driver;
  rows: Delivery[];
  totals: StatementTotals;
}

export interface Settlement {
  id: string;
  driver_id: string;
  created_at: string;
  deliveries_count: number;
  pay_cents: number;
  cash_cents: number;
  note: string | null;
}

export const getDeliverySettings = () => invoke<DeliverySettings>("get_delivery_settings_v3", { sessionToken: token() });
export const updateDeliverySettings = (payMode: PayMode, payValue: number) =>
  invoke<void>("update_delivery_settings_v3", { sessionToken: token(), payMode, payValue });

export const listDrivers = (includeInactive = false) => invoke<Driver[]>("list_delivery_drivers_v3", { sessionToken: token(), includeInactive });
export const saveDriver = (driver: { id: string | null; name: string; phone: string | null; pay_value: number | null; is_active: boolean }) =>
  invoke<string>("save_delivery_driver_v3", { sessionToken: token(), driver });

export const listDeliveries = (filter: { driver_id?: string; statuses?: DeliveryStatus[]; from?: string; to?: string } = {}) =>
  invoke<Delivery[]>("list_deliveries_v3", { sessionToken: token(), filter: { statuses: [], ...filter } });
export const assignDriver = (orderId: string, driverId: string | null) =>
  invoke<Delivery>("assign_delivery_driver_v3", { sessionToken: token(), orderId, driverId });
export const setDeliveryStatus = (orderId: string, newStatus: DeliveryStatus, note?: string) =>
  invoke<Delivery>("set_delivery_status_v3", { sessionToken: token(), orderId, newStatus, note: note ?? null });

export const getDriverStatement = (driverId: string, from?: string, to?: string) =>
  invoke<Statement>("get_driver_statement_v3", { sessionToken: token(), driverId, from: from ?? null, to: to ?? null });
export const listSettlements = (driverId: string) => invoke<Settlement[]>("list_driver_settlements_v3", { sessionToken: token(), driverId });
export const settleDriver = (driverId: string, orderIds: string[], note?: string) =>
  invoke<Settlement>("settle_driver_v3", { sessionToken: token(), driverId, orderIds, note: note ?? null });

// ---- pure helpers ----

/** What the driver collects from the customer on this delivery (0 when already paid at the till). */
export function toCollectCents(d: Pick<Delivery, "order_status" | "total_cents">): number {
  return d.order_status === "PAID" ? 0 : d.total_cents;
}

export function payUnitLabel(mode: PayMode): string {
  return mode === "PERCENT_OF_FEE" ? "% من رسوم التوصيل" : "لكل توصيلة";
}

/** The driver's pay as the owner would read it: "5,000 لكل توصيلة" or "50% من رسوم التوصيل". */
export function describePay(mode: PayMode, value: number): string {
  return mode === "PERCENT_OF_FEE" ? `${value}% من رسوم التوصيل` : `${formatMoney(value)} لكل توصيلة`;
}

/** Orders of a statement still open for settlement (pay or cash not yet handed over). */
export function openForSettlement(rows: readonly Delivery[]): Delivery[] {
  return rows.filter((r) => r.status === "DELIVERED" && (!r.pay_settled || (!r.cash_settled && r.cash_due_cents > 0)));
}

/** The money in one settlement, as a cashier reads it. */
export function settlementSummary(rows: readonly Delivery[]): { count: number; cash: number; pay: number; net: number } {
  let cash = 0;
  let pay = 0;
  for (const r of rows) {
    if (!r.cash_settled) cash += r.cash_due_cents;
    if (!r.pay_settled) pay += r.pay_cents;
  }
  return { count: rows.length, cash, pay, net: cash - pay };
}
