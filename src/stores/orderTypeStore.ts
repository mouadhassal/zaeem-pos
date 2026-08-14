import { create } from "zustand";

export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "ONLINE" | "DEBT";

interface OrderTypeState {
  orderType: OrderType;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  driverId: string;
  // 2026-08-14 backend hardening pass: delivery zones (fee/minimum/ETA)
  // were fully configurable in Settings but never actually applied to an
  // order -- the fee was hardcoded 0 in orderService.ts's createOrder.
  // Cashier picks the zone at checkout (no geo-matching exists anywhere
  // in this app), which sets both fields together so they can never drift.
  deliveryZoneId: string;
  deliveryFeeCents: number;
  debtorId: string | null;
  debtorName: string | null;
  setOrderType: (t: OrderType) => void;
  setCustomerName: (v: string) => void;
  setCustomerPhone: (v: string) => void;
  setDeliveryAddress: (v: string) => void;
  setDriverId: (v: string) => void;
  setDeliveryZone: (zoneId: string, feeCents: number) => void;
  setDebtor: (id: string, name: string) => void;
  resetOrderInfo: () => void;
}

export const useOrderTypeStore = create<OrderTypeState>((set) => ({
  orderType: "DINE_IN",
  customerName: "",
  customerPhone: "",
  deliveryAddress: "",
  driverId: "",
  deliveryZoneId: "",
  deliveryFeeCents: 0,
  debtorId: null,
  debtorName: null,

  setOrderType: (t) => set({ orderType: t }),
  setCustomerName: (v) => set({ customerName: v }),
  setCustomerPhone: (v) => set({ customerPhone: v }),
  setDeliveryAddress: (v) => set({ deliveryAddress: v }),
  setDriverId: (v) => set({ driverId: v }),
  setDeliveryZone: (zoneId, feeCents) => set({ deliveryZoneId: zoneId, deliveryFeeCents: feeCents }),
  setDebtor: (id, name) => set({ debtorId: id, debtorName: name }),

  resetOrderInfo: () =>
    set({
      orderType: "DINE_IN",
      customerName: "",
      customerPhone: "",
      deliveryAddress: "",
      driverId: "",
      deliveryZoneId: "",
      deliveryFeeCents: 0,
      debtorId: null,
      debtorName: null,
    }),
}));
