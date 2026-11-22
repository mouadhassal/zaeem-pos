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
  /** The cashier said "no bill" for this order: its bill does not print when it goes out. */
  no_bill?: boolean;
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

// ---- delivery apps (platforms): their accounts ----

export interface Platform {
  id: string;
  name: string;
  /** The app's cut in basis points (100 = 1%). */
  commission_bp: number;
  active: boolean;
}

/** One app's account for a period (the rules are in src-tauri/src/venue.rs). */
export interface PlatformAccount {
  platform_id: string;
  name: string;
  commission_bp: number;
  active: boolean;
  orders: number;
  sales_cents: number;
  commission_cents: number;
  net_due_cents: number;
  settled_cents: number;
  outstanding_cents: number;
}

export interface PlatformSettlement {
  id: string;
  platform_id: string;
  amount_cents: number;
  period_from: string | null;
  period_to: string | null;
  note: string | null;
  staff_id: string | null;
  created_at: string;
}

export const listPlatforms = (includeInactive = true) => invoke<Platform[]>("list_delivery_platforms_v3", { sessionToken: token(), includeInactive });
export const savePlatform = (platform: { id: string | null; name: string; commission_bp: number; active: boolean }) =>
  invoke<string>("save_delivery_platform_v3", { sessionToken: token(), platform });
export const platformAccounts = (from?: string, to?: string) =>
  invoke<PlatformAccount[]>("platform_accounts_v3", { sessionToken: token(), from: from ?? null, to: to ?? null });
export const recordPlatformSettlement = (platformId: string, amountCents: number, periodFrom?: string, periodTo?: string, note?: string) =>
  invoke<string>("record_platform_settlement_v3", { sessionToken: token(), platformId, amountCents, periodFrom: periodFrom ?? null, periodTo: periodTo ?? null, note: note ?? null });
export const listPlatformSettlements = (platformId: string, limit = 20) =>
  invoke<PlatformSettlement[]>("list_platform_settlements_v3", { sessionToken: token(), platformId, limit });

// ---- pure helpers ----

/** "15" or "12.5" (percent) -> basis points; null when it is not a percentage from 0 to 100. */
export function percentToBp(text: string): number | null {
  const t = text.trim().replace(",", ".").replace("%", "");
  if (t === "" || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bp = Math.round(Number(t) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** Basis points as the owner reads them: 1250 -> "12.5%". */
export function bpToPercentText(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** Totals row of the apps table. */
export function sumAccounts(rows: readonly PlatformAccount[]) {
  return rows.reduce(
    (t, r) => ({
      orders: t.orders + r.orders,
      sales_cents: t.sales_cents + r.sales_cents,
      commission_cents: t.commission_cents + r.commission_cents,
      net_due_cents: t.net_due_cents + r.net_due_cents,
      settled_cents: t.settled_cents + r.settled_cents,
      outstanding_cents: t.outstanding_cents + r.outstanding_cents,
    }),
    { orders: 0, sales_cents: 0, commission_cents: 0, net_due_cents: 0, settled_cents: 0, outstanding_cents: 0 },
  );
}

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
