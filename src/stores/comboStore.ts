import { create } from "zustand";

export interface ComboItem {
  menuItemId: string;
  name: string;
  quantity: number;
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
  addCombo: (combo: Combo) => void;
  removeCombo: (id: string) => void;
}

export const useComboStore = create<ComboState>((set) => ({
  combos: [],
  setCombos: (combos) => set({ combos }),
  addCombo: (combo) => set((s) => ({ combos: [...s.combos, combo] })),
  removeCombo: (id) => set((s) => ({ combos: s.combos.filter((c) => c.id !== id) })),
}));
