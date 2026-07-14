import { getDb } from "./index";

export type AuditAction =
  | "ORDER_CREATED"
  | "ORDER_PAID"
  | "ORDER_VOIDED"
  | "ORDER_HELD"
  | "ORDER_RETRIEVED"
  | "DISCOUNT_APPLIED"
  | "MANAGER_OVERRIDE"
  | "PRICE_CHANGED"
  | "INVENTORY_ADJUSTED"
  | "INVENTORY_WASTE"
  | "SHIFT_OPENED"
  | "SHIFT_CLOSED"
  | "USER_LOGIN"
  | "USER_LOGOUT"
  | "BACKUP_CREATED"
  | "RESTORE_EXECUTED"
  | "SYNC_STARTED"
  | "SYNC_COMPLETED"
  | "SYNC_FAILED"
  | "CORRUPTION_DETECTED"
  | "SETTINGS_CHANGED";

export interface AuditEntry {
  id: string;
  user_id: string;
  action: AuditAction;
  entity_type?: string;
  entity_id?: string;
  old_value?: string;
  new_value?: string;
  ip_address?: string;
  user_agent?: string;
  timestamp: string;
}

export async function logAudit(entry: {
  userId: string;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  oldValue?: string;
  newValue?: string;
}): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insertInto("audit_logs")
      .values({
        id: crypto.randomUUID(),
        user_id: entry.userId,
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId ?? null,
        old_value: entry.oldValue ?? null,
        new_value: entry.newValue ?? null,
        ip_address: null,
        user_agent: null,
        timestamp: new Date().toISOString(),
        sync_version: 1,
        last_modified: new Date().toISOString(),
        sync_status: "synced",
      })
      .execute();
  } catch (err) {
    console.error("Failed to write audit log:", err);
  }
}

export async function queryAuditLogs(filters?: {
  userId?: string;
  action?: AuditAction;
  entityType?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}): Promise<AuditEntry[]> {
  const db = await getDb();
  let query = db.selectFrom("audit_logs").selectAll().orderBy("timestamp", "desc");

  if (filters?.userId) {
    query = query.where("user_id", "=", filters.userId);
  }
  if (filters?.action) {
    query = query.where("action", "=", filters.action);
  }
  if (filters?.entityType) {
    query = query.where("entity_type", "=", filters.entityType);
  }
  if (filters?.fromDate) {
    query = query.where("timestamp", ">=", filters.fromDate);
  }
  if (filters?.toDate) {
    query = query.where("timestamp", "<=", filters.toDate);
  }

  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  return (await query.limit(limit).offset(offset).execute()) as unknown as AuditEntry[];
}
