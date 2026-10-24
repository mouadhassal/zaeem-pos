// Daily order numbers (A-0001 takeaway, B-0001 dine-in, C-0001 delivery),
// handed out by the main terminal when the order is written -- see
// src-tauri/src/order_history.rs. Tickets, the kitchen screen and lists show
// that number; an order from before daily numbers keeps its old short code.
import { useEffect, useState } from "react";
import { invoke } from "./invoke";
import { useAuthStore } from "../stores/authStore";
import { orderNo } from "./orderNumber";

export interface OrderNumberInfo {
  label: string;
  business_date: string;
}

// null = asked, and the order has no daily number (it predates them).
const cache = new Map<string, OrderNumberInfo | null>();

export async function loadOrderNumbers(ids: readonly string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => id && !cache.has(id));
  if (missing.length === 0) return;
  const got = await invoke<Record<string, OrderNumberInfo>>("get_order_numbers_v3", {
    sessionToken: useAuthStore.getState().token ?? "",
    orderIds: missing,
  });
  for (const id of missing) cache.set(id, got[id] ?? null);
}

/** The daily number if already known, else the old short code. */
export function cachedOrderLabel(id: string): string {
  return cache.get(id)?.label ?? orderNo(id);
}

/** For a ticket or receipt: the daily number, or the old short code if it cannot be had. */
export async function orderLabel(id: string): Promise<string> {
  try {
    await loadOrderNumbers([id]);
  } catch {
    // The short code still identifies the order on paper.
  }
  return cachedOrderLabel(id);
}

/** For a list: fetches the numbers of `ids` once and re-renders when they arrive. */
export function useOrderLabels(ids: readonly string[]): (id: string) => string {
  const key = ids.join(",");
  const [, setLoaded] = useState(0);
  useEffect(() => {
    let alive = true;
    loadOrderNumbers(key ? key.split(",") : [])
      .then(() => {
        if (alive) setLoaded((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);
  return cachedOrderLabel;
}
