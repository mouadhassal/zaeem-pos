import { create } from "zustand";
import { invoke } from "../lib/invoke";
import { useAuthStore } from "./authStore";

/**
 * The business type and the modules switched on (business.rs), plus the tables/kitchen switches
 * (chain_config). `modules` is null until loaded: everything shows. Tables and kitchen start on, like the server's default.
 */
interface BusinessState {
  businessType: string | null;
  modules: Record<string, boolean> | null;
  hasTables: boolean;
  hasKitchen: boolean;
  load: () => Promise<void>;
  save: (businessType: string, modules: Record<string, boolean>) => Promise<void>;
  /** After tables/kitchen were saved elsewhere (Settings), so the words and the sidebar follow at once. */
  setMode: (mode: { has_tables: boolean; has_kitchen: boolean }) => void;
}

export const useBusinessStore = create<BusinessState>((set) => ({
  businessType: null,
  modules: null,
  hasTables: true,
  hasKitchen: true,
  load: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;
    try {
      const p = await invoke<{ business_type: string | null; modules: Record<string, boolean> }>("get_business_profile_v3", { sessionToken: token });
      set({ businessType: p.business_type, modules: p.modules });
    } catch {
      // A satellite or an old hub: every module stays visible (the server still decides).
    }
    try {
      const m = await invoke<{ has_tables: boolean; has_kitchen: boolean }>("get_business_mode_v3", { sessionToken: token });
      set({ hasTables: m.has_tables, hasKitchen: m.has_kitchen });
    } catch {
      // Keep the last known switches.
    }
  },
  save: async (businessType, modules) => {
    const token = useAuthStore.getState().token;
    await invoke("save_business_profile_v3", { sessionToken: token, profile: { business_type: businessType, modules } });
    set({ businessType, modules });
  },
  setMode: (mode) => set({ hasTables: mode.has_tables, hasKitchen: mode.has_kitchen }),
}));
