import { useEffect } from "react";
import { invoke } from "../lib/invoke";
import { isSatellite } from "../lib/lan";
import { autoReceiptLines, EMPTY_MARKET_STATUS, type MarketStatus } from "../lib/marketSync";
import type { PendingReceipts } from "../lib/marketplaceReceipt";
import { useAuthStore } from "../stores/authStore";
import { useMarketStore } from "../stores/marketStore";
import { getPrefs } from "../stores/prefsStore";

const ROUND_MS = 120_000;

interface SupplierSyncOutcome {
  is_supplier: boolean;
  applied_orders: number;
  needs_link_orders: number;
  published: number;
  error: string | null;
}

/**
 * Keeps the shop and the WENZDES Marketplace together, every couple of minutes, on the main till only
 * and only for a manager or the owner (the commands refuse anyone else). Buying: goods that arrived are
 * added to the stock by themselves when every line is certain (the owner's switch), the rest wait in the
 * bell. Selling (a supplier): accepted customer orders leave the stock and the stock is published to the
 * marketplace. Every failure is swallowed: no internet or no cloud licence just means nothing happens.
 */
export function useMarketSync(): void {
  const token = useAuthStore((s) => s.token);
  const role = String(useAuthStore((s) => s.user?.role) ?? "").toUpperCase();
  const allowed = ["OWNER", "MANAGER", "ADMIN", "PLATFORM"].includes(role);

  useEffect(() => {
    if (!token || !allowed) {
      useMarketStore.getState().setStatus(EMPTY_MARKET_STATUS);
      return;
    }
    let stopped = false;
    let notASupplierUntil = 0;

    const round = async () => {
      try {
        if (await isSatellite()) return;
      } catch { /* treat as the main till */ }
      const prefs = getPrefs();
      const status: MarketStatus = { ...EMPTY_MARKET_STATUS };

      try {
        const pending = await invoke<PendingReceipts>("list_marketplace_receipts_v3", { sessionToken: token });
        for (const order of pending.orders) {
          const lines = prefs.marketAutoReceive ? autoReceiptLines(order) : null;
          if (!lines) { status.receiptsToReview++; continue; }
          try {
            if (await invoke<boolean>("receive_marketplace_order_v3", { sessionToken: token, orderId: order.order_id, lines, note: "تلقائي" })) status.lastAutoReceived++;
          } catch { status.receiptsToReview++; }
        }
      } catch { /* no cloud licence, offline, or not allowed */ }

      if (Date.now() >= notASupplierUntil) {
        try {
          const out = await invoke<SupplierSyncOutcome>("supplier_market_sync_v3", { sessionToken: token, autoApply: prefs.marketAutoApply });
          status.isSupplier = out.is_supplier;
          status.ordersNeedLinks = out.needs_link_orders;
          status.lastAppliedOrders = out.applied_orders;
          status.error = out.error;
          // A shop that is not a supplier is asked again only now and then.
          if (!out.is_supplier && !out.error) notASupplierUntil = Date.now() + 10 * 60_000;
        } catch { /* same */ }
      }
      if (!stopped) useMarketStore.getState().setStatus(status);
    };

    void round();
    const t = setInterval(() => void round(), ROUND_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [token, allowed]);
}
