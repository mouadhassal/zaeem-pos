import { create } from "zustand";
import type { TaxConfig, TaxResult } from "../lib/taxCalculator";
import { calculateTax } from "../lib/taxCalculator";
import type { ComboComponent } from "./menuStore";
import { lineKey } from "../lib/itemOptions";
import { formatWeight } from "../lib/weight";

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
  /** "On the house": stays on the order at its real price but is not charged. */
  comped?: boolean;
  compReason?: string;
  isCombo?: boolean;
  comboOriginalPriceCents?: number;
  comboComponents?: ComboComponent[];
  savingsCents?: number;
  /** Present only when this item was loaded from an already-persisted order_items row (a held/reopened order). */
  dbItemId?: string;
  /**
   * Sold by weight (lib/weight.ts): the portion in grams. Such a line is quantity 1 and
   * `unitPriceCents` is the price of the portion; the server prices it again from the weight.
   */
  weightGrams?: number;
  /** The menu's per-kilogram price this portion was priced at (for display). */
  pricePerKgCents?: number;
  /** Set when the customer asked for an exact amount ("give me 10,000 of it"): charged exactly. */
  exactAmountCents?: number;
  /**
   * A special price for this line (a friend, a regular): how much cheaper each unit is than the
   * menu price. It is never sent as a lower price (the server prices from the menu): it is added
   * to the order's discount, so the discount cap, the manager's PIN and the audit all still apply.
   */
  cutPerUnitCents?: number;
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
  /** The whole discount the order is sent with: `manualDiscountCents` plus every line's special price. */
  discountCents: number;
  discountReason: string;
  /** The discount typed for the order itself (a loyalty reward, a manager's discount). */
  manualDiscountCents: number;
  manualDiscountReason: string;
  taxConfig: TaxConfig | undefined;
  splits: SplitItem[];
  /** DELIVERY only: the fee charged on top of the food (untaxed). */
  deliveryFeeCents: number;

  addItem: (item: Omit<CartItem, "id">) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, delta: number) => void;
  /** Sets a line's quantity to a typed number (1 or more; weighed lines keep theirs). */
  setQuantity: (id: string, quantity: number) => void;
  /** A special price for one line: `cutPerUnitCents` off each unit (0 takes it back). Only for lines not yet sent. */
  setLineCut: (id: string, cutPerUnitCents: number) => void;
  voidItem: (id: string, reason: string) => void;
  /** Replaces the options and note of one line (cashier edited it before sending). */
  setLineOptions: (id: string, modifiers: CartModifier[], notes: string) => void;
  /** Changes the portion of a line sold by weight (one that is not on the server yet). */
  setLineWeight: (id: string, portion: { weightGrams: number; unitPriceCents: number; exactAmountCents?: number }) => void;
  /** Marks a line as a gift (or takes the gift back). */
  setLineComp: (id: string, comped: boolean, reason: string) => void;
  setDiscount: (cents: number, reason: string) => void;
  setTable: (id: string, name: string) => void;
  setSplits: (splits: SplitItem[]) => void;
  setDeliveryFee: (cents: number) => void;
  setTaxConfig: (config: TaxConfig) => void;
  clearCart: () => void;
  subtotal: () => number;
  savings: () => number;
  tax: () => TaxResult;
  total: () => number;
}

let nextId = 1;

/** What the lines' special prices add up to. */
export function lineCutsTotal(items: CartItem[]): number {
  return items
    .filter((i) => !i.voided && !i.comped)
    .reduce((sum, i) => sum + (i.cutPerUnitCents ?? 0) * i.quantity, 0);
}

/** The discount the order carries: the typed one plus the lines' special prices. */
function withDiscount(items: CartItem[], manualCents: number, manualReason: string) {
  const cuts = lineCutsTotal(items);
  return {
    items,
    discountCents: manualCents + cuts,
    discountReason: cuts > 0 ? (manualReason ? `${manualReason} + سعر خاص` : "سعر خاص") : manualReason,
  };
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  tableId: null,
  tableName: null,
  discountCents: 0,
  discountReason: "",
  manualDiscountCents: 0,
  manualDiscountReason: "",
  taxConfig: { mode: "exclusive", taxRateCents: 1500, secondaryTaxRateCents: 0, serviceChargeRateCents: 0 },
  splits: [],
  deliveryFeeCents: 0,

  addItem: (item) =>
    set((state) => {
      // Same item with different options, note or gift status is a different line,
      // and a line that already exists on the server is never merged into or out of.
      // A weighed portion is always its own line: two 285 g portions are not "2 of" anything.
      // A line with a special price is not topped up either: the new unit is at the menu price.
      const existing = item.weightGrams ? undefined : state.items.find(
        (i) => i.menuItemId === item.menuItemId && !i.comboId && !i.voided && !i.dbItemId && !item.dbItemId && !i.weightGrams && !i.cutPerUnitCents && lineKey(i) === lineKey(item)
      );
      if (existing && !item.comboId) {
        return withDiscount(
          state.items.map((i) =>
            i.id === existing.id
              ? { ...i, quantity: i.quantity + Math.max(1, item.quantity || 1) }
              : i
          ),
          state.manualDiscountCents, state.manualDiscountReason,
        );
      }
      return withDiscount(
        [...state.items, { ...item, id: `cart-${nextId++}` }],
        state.manualDiscountCents, state.manualDiscountReason,
      );
    }),

  removeItem: (id) =>
    set((state) => withDiscount(state.items.filter((i) => i.id !== id), state.manualDiscountCents, state.manualDiscountReason)),

  updateQuantity: (id, delta) =>
    set((state) => withDiscount(
      state.items
        .map((i) =>
          i.id === id && !i.weightGrams ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i
        )
        .filter((i) => i.quantity > 0),
      state.manualDiscountCents, state.manualDiscountReason,
    )),

  setQuantity: (id, quantity) =>
    set((state) => withDiscount(
      state.items.map((i) =>
        i.id === id && !i.weightGrams && Number.isInteger(quantity) && quantity >= 1 ? { ...i, quantity } : i
      ),
      state.manualDiscountCents, state.manualDiscountReason,
    )),

  setLineCut: (id, cutPerUnitCents) =>
    set((state) => withDiscount(
      state.items.map((i) => {
        if (i.id !== id || i.weightGrams || i.dbItemId || i.comped) return i;
        const unit = i.unitPriceCents + i.modifiers.reduce((sum, m) => sum + m.priceCents, 0);
        const cut = Math.min(Math.max(0, Math.round(cutPerUnitCents || 0)), unit);
        const { cutPerUnitCents: _drop, ...rest } = i;
        return cut > 0 ? { ...rest, cutPerUnitCents: cut } : rest;
      }),
      state.manualDiscountCents, state.manualDiscountReason,
    )),

  voidItem: (id, reason) =>
    set((state) => withDiscount(
      state.items.map((i) =>
        i.id === id ? { ...i, voided: 1, voidReason: reason } : i
      ),
      state.manualDiscountCents, state.manualDiscountReason,
    )),

  setLineOptions: (id, modifiers, notes) =>
    set((state) => ({
      items: state.items.map((i) => (i.id === id ? { ...i, modifiers, notes } : i)),
    })),

  setLineWeight: (id, portion) =>
    set((state) => ({
      items: state.items.map((i) => {
        if (i.id !== id || !i.weightGrams || i.dbItemId) return i;
        const { exactAmountCents: _drop, ...rest } = i;
        return {
          ...rest,
          name: i.name.replace(/ — [^—]*$/, "") + ` — ${formatWeight(portion.weightGrams)}`,
          weightGrams: portion.weightGrams,
          unitPriceCents: portion.unitPriceCents,
          ...(portion.exactAmountCents ? { exactAmountCents: portion.exactAmountCents } : {}),
        };
      }),
    })),

  setLineComp: (id, comped, reason) =>
    set((state) => withDiscount(
      state.items.map((i) => {
        if (i.id !== id) return i;
        const { compReason: _drop, ...rest } = i;
        return comped ? { ...rest, comped: true, compReason: reason } : { ...rest, comped: false };
      }),
      state.manualDiscountCents, state.manualDiscountReason,
    )),

  setDiscount: (cents, reason) =>
    set((state) => ({ ...withDiscount(state.items, cents, reason), manualDiscountCents: cents, manualDiscountReason: reason })),

  setTable: (id, name) => set({ tableId: id, tableName: name }),

  setSplits: (splits) => set({ splits }),

  setDeliveryFee: (cents) => set({ deliveryFeeCents: Math.max(0, Math.round(cents || 0)) }),

  setTaxConfig: (config) => set({ taxConfig: config }),

  clearCart: () =>
    set({
      items: [],
      tableId: null,
      tableName: null,
      discountCents: 0,
      discountReason: "",
      manualDiscountCents: 0,
      manualDiscountReason: "",
      splits: [],
      deliveryFeeCents: 0,
      taxConfig: undefined,
    }),

  subtotal: () => {
    const { items } = get();
    return items
      .filter((i) => !i.voided && !i.comped)
      .reduce(
        (sum, i) =>
          sum + (i.unitPriceCents + i.modifiers.reduce((m, m2) => m + m2.priceCents, 0)) * i.quantity,
        0
      );
  },

  savings: () => {
    const { items } = get();
    return items
      .filter((i) => !i.voided)
      .reduce((sum, i) => sum + (i.savingsCents ?? 0) * i.quantity, 0);
  },

  tax: () => {
    const s = get().subtotal();
    const d = get().discountCents;
    const taxConfig = get().taxConfig ?? { mode: "exclusive" as const, taxRateCents: 0, secondaryTaxRateCents: 0, serviceChargeRateCents: 0 };
    return calculateTax(s, d, taxConfig);
  },

  total: () => {
    const t = get().tax();
    return t.totalCents + get().deliveryFeeCents;
  },
}));
