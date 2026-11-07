import { create } from "zustand";
import { invoke } from "../lib/invoke";
import { useAuthStore } from "./authStore";

/**
 * What the signed-in person may open, as the owner set it (Settings > الصلاحيات), by feature key.
 * `null` until the till has asked: the sidebar then shows the role's normal pages.
 */
interface AccessState {
  features: Record<string, boolean> | null;
  load: () => Promise<void>;
  reset: () => void;
}

export const useAccessStore = create<AccessState>((set) => ({
  features: null,
  load: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;
    try {
      const features = await invoke<Record<string, boolean>>("get_my_access_v3", { sessionToken: token });
      set({ features });
    } catch {
      // Could not ask (a satellite till, a closed hub): the role's normal pages stay.
    }
  },
  reset: () => set({ features: null }),
}));
