import { create } from "zustand";

export type OrderType = "DINE_IN" | "TAKEAWAY" | "ONLINE" | "DEBT";

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