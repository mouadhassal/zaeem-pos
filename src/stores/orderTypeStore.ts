import { create } from "zustand";

// ONLINE deliberately excluded here: this store models the order types the
// POS *cashier screen* can create (top bar in pos/page.tsx), and there is
// no "online order" entry point on this screen -- ONLINE orders arrive
// through a separate integration and are only ever displayed (KDS,
// reports, printer), never created here. `db/types.ts`'s OrderType is the
// broader read-side type and still includes it.
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DEBT" | "DELIVERY";

interface OrderTypeState {
  orderType: OrderType;
  customerName: string;
  customerPhone: string;
  /** DELIVERY only: where to take it, and which driver (optional until assigned on the Delivery page). */
  deliveryAddress: string;
  driverId: string;
  debtorId: string | null;
  debtorName: string | null;
  /** TAKEAWAY only: a phone order the customer collects later (epoch ms), or null to pay now. */
  pickupAtMs: number | null;
  setOrderType: (t: OrderType) => void;
  setPickupAtMs: (v: number | null) => void;
  setCustomerName: (v: string) => void;
  setCustomerPhone: (v: string) => void;
  setDeliveryAddress: (v: string) => void;
  setDriverId: (v: string) => void;
  setDebtor: (id: string, name: string) => void;
  resetOrderInfo: () => void;
}

export const useOrderTypeStore = create<OrderTypeState>((set) => ({
  orderType: "DINE_IN",
  customerName: "",
  customerPhone: "",
  deliveryAddress: "",
  driverId: "",
  debtorId: null,
  debtorName: null,
  pickupAtMs: null,

  setOrderType: (t) => set({ orderType: t }),
  setPickupAtMs: (v) => set({ pickupAtMs: v }),
  setCustomerName: (v) => set({ customerName: v }),
  setCustomerPhone: (v) => set({ customerPhone: v }),
  setDeliveryAddress: (v) => set({ deliveryAddress: v }),
  setDriverId: (v) => set({ driverId: v }),
  setDebtor: (id, name) => set({ debtorId: id, debtorName: name }),

  resetOrderInfo: () =>
    set({
      orderType: "DINE_IN",
      customerName: "",
      customerPhone: "",
      deliveryAddress: "",
      driverId: "",
      debtorId: null,
      debtorName: null,
      pickupAtMs: null,
    }),
}));