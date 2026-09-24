import { create } from "zustand";

// ONLINE deliberately excluded here: this store models the order types the
// POS *cashier screen* can create (top bar in pos/page.tsx), and there is
// no "online order" entry point on this screen -- ONLINE orders arrive
// through a separate integration and are only ever displayed (KDS,
// reports, printer), never created here. `db/types.ts`'s OrderType is the
// broader read-side type and still includes it.
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DEBT";

interface OrderTypeState {
  orderType: OrderType;
  customerName: string;
  customerPhone: string;
  debtorId: string | null;
  debtorName: string | null;
  setOrderType: (t: OrderType) => void;
  setCustomerName: (v: string) => void;
  setCustomerPhone: (v: string) => void;
  setDebtor: (id: string, name: string) => void;
  resetOrderInfo: () => void;
}

export const useOrderTypeStore = create<OrderTypeState>((set) => ({
  orderType: "DINE_IN",
  customerName: "",
  customerPhone: "",
  debtorId: null,
  debtorName: null,

  setOrderType: (t) => set({ orderType: t }),
  setCustomerName: (v) => set({ customerName: v }),
  setCustomerPhone: (v) => set({ customerPhone: v }),
  setDebtor: (id, name) => set({ debtorId: id, debtorName: name }),

  resetOrderInfo: () =>
    set({
      orderType: "DINE_IN",
      customerName: "",
      customerPhone: "",
      debtorId: null,
      debtorName: null,
    }),
}));