const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://your-ref.supabase.co";
const SYNC_ENDPOINT = `${SUPABASE_URL}/functions/v1/sync-pos`;
const DEVICE_TOKEN_KEY = "zaeem_device_token";

export function getDeviceToken(): string | null {
  return localStorage.getItem(DEVICE_TOKEN_KEY);
}

export function setDeviceToken(token: string) {
  localStorage.setItem(DEVICE_TOKEN_KEY, token);
}

export interface PosOrder {
  pos_order_id: string;
  order_type: "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "DEBT";
  status: string;
  total_cents: number;
  tax_cents: number;
  items: Array<{ name: string; qty: number; price_cents: number }>;
  customer_name?: string;
  customer_phone?: string;
  delivery_address?: string;
  table_id?: string;
  created_at: string;
}

async function postToSync(body: Record<string, unknown>): Promise<any> {
  const token = getDeviceToken();
  if (!token) return null;

  const resp = await fetch(SYNC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, device_token: token }),
  });

  if (!resp.ok) {
    console.error("[sync] Edge Function error:", resp.status);
    return null;
  }
  return resp.json();
}

export async function validateLicense(licenseKey: string): Promise<boolean> {
  setDeviceToken(licenseKey);
  const result = await postToSync({ heartbeat: true });
  return result?.ok === true;
}

export async function sendHeartbeat(): Promise<boolean> {
  const result = await postToSync({ heartbeat: true });
  return result?.ok === true;
}

export async function getSyncStatus() {
  const result = await postToSync({ heartbeat: true });
  return result || { ok: false, online: false };
}

export async function syncOrder(order: PosOrder): Promise<boolean> {
  const result = await postToSync({ orders: [order] });
  return result?.ok === true;
}

export function autoSyncOrder(order: any) {
  const payload: PosOrder = {
    pos_order_id: order.id,
    order_type: order.type || "DINE_IN",
    status: order.status || "PENDING",
    total_cents: order.totalCents || 0,
    tax_cents: order.taxCents || 0,
    items: (order.items || []).map((item: any) => ({
      name: item.name,
      qty: item.quantity || 1,
      price_cents: item.unitPriceCents || 0,
    })),
    customer_name: order.customerName,
    customer_phone: order.customerPhone,
    delivery_address: order.deliveryAddress,
    table_id: order.tableId,
    created_at: new Date().toISOString(),
  };

  syncOrder(payload).catch(console.error);
}
