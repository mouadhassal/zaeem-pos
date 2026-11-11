import { create } from "zustand";

/**
 * "Edit this order": a screen that lists orders (Delivery, the pickup queue,
 * Order history) cannot change one itself. It hands the order to the till
 * through this store and opens the till, which loads it as an open order and
 * gives the cashier the same tools as for a table's open tab: change or
 * remove a line already sent (with a reason, and the kitchen is told), add
 * more (sent to the kitchen as an addition), or cancel the whole order.
 */
export interface EditOrderRequest {
  orderId: string;
  orderType: "DELIVERY" | "TAKEAWAY";
  /** Delivery only: shown on the bill panel and kept on the order. */
  deliveryFeeCents?: number;
  address?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  /** Where to go back to when the cashier is done. */
  returnTo?: string;
}

interface EditOrderState {
  request: EditOrderRequest | null;
  begin: (r: EditOrderRequest) => void;
  /** The till took the request. */
  take: () => EditOrderRequest | null;
}

export const useEditOrderStore = create<EditOrderState>((set, get) => ({
  request: null,
  begin: (request) => set({ request }),
  take: () => {
    const r = get().request;
    if (r) set({ request: null });
    return r;
  },
}));
