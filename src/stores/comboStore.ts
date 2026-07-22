import { create } from "zustand";

export interface ComboItem {
  menuItemId: string;
  name: string;
  quantity: number;
  priceCents: number;
}

export interface Combo {
  id: string;
  name: string;
  bundlePriceCents: number;
  items: ComboItem[];
}

interface ComboState {
  combos: Combo[];
  setCombos: (combos: Combo[]) => void;
}

export const useComboStore = create<ComboState>((set) => ({
  combos: [],
  setCombos: (combos) => set({ combos }),
}));
