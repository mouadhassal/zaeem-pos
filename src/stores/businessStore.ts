import { create } from "zustand";
import { invoke } from "../lib/invoke";
import { useAuthStore } from "./authStore";

/** The business type and the modules switched on (business.rs). `modules` is null until loaded: everything shows. */
interface BusinessState {
  businessType: string | null;
  modules: Record<string, boolean> | null;
  load: () => Promise<void>;
  save: (businessType: string, modules: Record<string, boolean>) => Promise<void>;
}

export const useBusinessStore = create<BusinessState>((set) => ({
  businessType: null,
  modules: null,
  load: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;
    try {
      const p = await invoke<{ business_type: string | null; modules: Record<string, boolean> }>("get_business_profile_v3", { sessionToken: token });
      set({ businessType: p.business_type, modules: p.modules });
    } catch {
      // A satellite or an old hub: every module stays visible (the server still decides).
    }
  },
  save: async (businessType, modules) => {
    const token = useAuthStore.getState().token;
    await invoke("save_business_profile_v3", { sessionToken: token, profile: { business_type: businessType, modules } });
    set({ businessType, modules });
  },
}));
