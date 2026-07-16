import { create } from "zustand";
import type { OrderType } from "./orderTypeStore";
import type { TaxConfig, TaxResult } from "../lib/taxCalculator";
import { calculateTax } from "../lib/taxCalculator";
import type { ComboComponent } from "./menuStore";

export interface CartModifier {
  name: string;
  priceCents: number;
}

export interface CartItem {
  id: string;
  menuItemId: string;
  name: string;
  categoryName?: string;
  quantity: number;
  unitPriceCents: number;
  modifiers: CartModifier[];
  notes: string;
  comboId?: string;
  voided?: number;
  voidReason?: string;
  isCombo?: boolean;
  comboOriginalPriceCents?: number;
  comboComponents?: ComboComponent[];
  savingsCents?: number;
  /** Present only when this item was loaded from an already-persisted order_items row (a held/reopened order). */
  dbItemId?: string;
}

export interface SplitItem {
  id: string;
  label: string;
  itemIds: string[];
  amountCents: number;
}

interface CartState {
  items: CartItem[];
  tableId: string | null;
  tableName: string | null;
  discountCents: number;
  discountReason: string;
  taxConfig: TaxConfig;
  orderType: OrderType;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  savingsCents: number;
  splits: SplitItem[];

  addItem: (item: Omit<CartItem, "id">) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, delta: number) => void;
  voidItem: (id: string, reason: string) => void;
  setDiscount: (cents: number, reason: string) => void;
  setTable: (id: string, name: string) => void;
  setOrderType: (t: OrderType) => void;
  setCustomerInfo: (name: string, phone: string, address: string) => void;
  setSavingsCents: (cents: number) => void;
  setSplits: (splits: SplitItem[]) => void;
  setTaxConfig: (config: TaxConfig) => void;
  clearCart: () => void;
  subtotal: () => number;
  tax: () => TaxResult;
  total: () => number;
}

let nextId = 1;

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  tableId: null,
  tableName: null,
  discountCents: 0,
  discountReason: "",
  taxConfig: { mode: "exclusive", taxRateCents: 1500, secondaryTaxRateCents: 0, serviceChargeRateCents: 0 },
  orderType: "DINE_IN",
  customerName: "",
  customerPhone: "",
  deliveryAddress: "",
  savingsCents: 0,
  splits: [],

  addItem: (item) =>
    set((state) => {
      const existing = state.items.find(
        (i) => i.menuItemId === item.menuItemId && !i.comboId
      );
      if (existing && !item.comboId) {
        return {
          items: state.items.map((i) =>
            i.id === existing.id
              ? { ...i, quantity: i.quantity + 1 }
              : i
          ),
        };
      }
      return {
        items: [
          ...state.items,
          { ...item, id: `cart-${nextId++}` },
        ],
      };
    }),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((i) => i.id !== id),
    })),

  updateQuantity: (id, delta) =>
    set((state) => ({
      items: state.items
        .map((i) =>
          i.id === id ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i
        )
        .filter((i) => i.quantity > 0),
    })),

  voidItem: (id, reason) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.id === id ? { ...i, voided: 1, voidReason: reason } : i
      ),
    })),

  setDiscount: (cents, reason) =>
    set({ discountCents: cents, discountReason: reason }),

  setTable: (id, name) => set({ tableId: id, tableName: name }),

  setOrderType: (t) => set({ orderType: t }),

  setCustomerInfo: (name, phone, address) =>
    set({ customerName: name, customerPhone: phone, deliveryAddress: address }),

  setSavingsCents: (cents) => set({ savingsCents: cents }),

  setSplits: (splits) => set({ splits }),

  setTaxConfig: (config) => set({ taxConfig: config }),

  clearCart: () =>
    set({
      items: [],
      tableId: null,
      tableName: null,
      discountCents: 0,
      discountReason: "",
      orderType: "DINE_IN",
      customerName: "",
      customerPhone: "",
      deliveryAddress: "",
      savingsCents: 0,
      splits: [],
    }),

  subtotal: () => {
    const { items } = get();
    return items
      .filter((i) => !i.voided)
      .reduce(
        (sum, i) =>
          sum + (i.unitPriceCents + i.modifiers.reduce((m, m2) => m + m2.priceCents, 0)) * i.quantity,
        0
      );
  },

  tax: () => {
    const s = get().subtotal();
    const d = get().discountCents;
    const taxConfig = get().taxConfig;
    return calculateTax(s, d, taxConfig);
  },

  total: () => {
    const t = get().tax();
    return t.totalCents;
  },
}));
