// Plain scalar type aliases shared across the frontend. This file used to
// also hold Kysely table interfaces (one per SQL table) for the old
// query-building layer; those are gone along with the Kysely/SQL-plugin
// dependency (Batch 3b closeout -- the frontend no longer touches the
// database at all, Rust owns every query). These aliases are kept because
// pages still import them for UI typing (role badges, status labels, etc.),
// independent of how the data actually gets fetched.
export type UserRole = "CASHIER" | "MANAGER" | "ADMIN" | "OWNER" | "ACCOUNTANT" | "KITCHEN";
export type DriverStatus = "AVAILABLE" | "BUSY" | "OFFLINE" | "INACTIVE";
export type VehicleType = "CAR" | "MOTORCYCLE" | "BIKE" | "VAN" | "TRUCK";
export type DeliveryStatus = "ASSIGNED" | "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "CANCELLED";
export type TableStatus = "FREE" | "OCCUPIED" | "MERGED";
export type OrderStatus = "DRAFT" | "PENDING" | "PREPARING" | "READY" | "SERVED" | "PAID" | "CANCELLED" | "SCHEDULED" | "VOIDED";
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "ONLINE";
export type PaymentMethod = "CASH" | "CARD" | "WALLET" | "CREDIT";
export type SyncOp = "INSERT" | "UPDATE" | "DELETE";
export type PrinterType = "RECEIPT" | "KITCHEN" | "LABEL";
export type PrinterInterface = "USB" | "NETWORK" | "BLUETOOTH";
export type TaxMode = "inclusive" | "exclusive";
