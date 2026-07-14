import { create } from "zustand";

export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "ONLINE";

interface OrderTypeState {
  orderType: OrderType;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  driverId: string;
  setOrderType: (t: OrderType) => void;
  setCustomerName: (v: string) => void;
  setCustomerPhone: (v: string) => void;
  setDeliveryAddress: (v: string) => void;
  setDriverId: (v: string) => void;
  resetOrderInfo: () => void;
}

export const useOrderTypeStore = create<OrderTypeState>((set) => ({
  orderType: "DINE_IN",
  customerName: "",
  customerPhone: "",
  deliveryAddress: "",
  driverId: "",

  setOrderType: (t) => set({ orderType: t }),
  setCustomerName: (v) => set({ customerName: v }),
  setCustomerPhone: (v) => set({ customerPhone: v }),
  setDeliveryAddress: (v) => set({ deliveryAddress: v }),
  setDriverId: (v) => set({ driverId: v }),

  resetOrderInfo: () =>
    set({
      orderType: "DINE_IN",
      customerName: "",
      customerPhone: "",
      deliveryAddress: "",
      driverId: "",
    }),
}));
