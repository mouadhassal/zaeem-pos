import { create } from "zustand";
import { normalizeProductsPerRow } from "../lib/menuGridLayout";

// A screen preference, not shop data: each till keeps its own (a 15" main
// register and a small satellite want different counts), so it lives in this
// device's localStorage rather than in the database.
const STORAGE_KEY = "zaeem_pos_products_per_row";

function readStored(): number {
  try {
    return normalizeProductsPerRow(localStorage.getItem(STORAGE_KEY));
  } catch {
    return 0;
  }
}

interface MenuGridState {
  /** 0 = auto. */
  productsPerRow: number;
  setProductsPerRow: (n: number) => void;
}

export const useMenuGridStore = create<MenuGridState>((set) => ({
  productsPerRow: readStored(),
  setProductsPerRow: (n) => {
    const value = normalizeProductsPerRow(n);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Storage blocked: the choice still applies until the app restarts.
    }
    set({ productsPerRow: value });
  },
}));
