import { create } from "zustand";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * Whether THIS till may open the back office. A hub or standalone till always may; a second till
 * (joined over the router or the internet) asks the hub, which looks the answer up by who is asking
 * (Settings > الشبكة المحلية on the hub). `null` until asked: the sidebar then shows what it always did.
 * The hub enforces the answer on every back-office command, so this only decides what is shown.
 */
export interface BackOfficeAccess {
  isSatellite: boolean;
  allowed: boolean;
  error?: string | null;
}

interface BackOfficeState {
  access: BackOfficeAccess | null;
  loadedAt: number;
  /** Asks at most once a minute unless `force`. */
  load: (force?: boolean) => Promise<void>;
  reset: () => void;
}

export const BACK_OFFICE_CACHE_MS = 60_000;

export const useBackOfficeStore = create<BackOfficeState>((set, get) => ({
  access: null,
  loadedAt: 0,
  load: async (force = false) => {
    if (!force && get().access && Date.now() - get().loadedAt < BACK_OFFICE_CACHE_MS) return;
    try {
      const r = await tauriInvoke<BackOfficeAccess>("get_back_office_access_v3");
      set({ access: { isSatellite: !!r.isSatellite, allowed: !!r.allowed, error: r.error ?? null }, loadedAt: Date.now() });
    } catch {
      // No Tauri bridge (browser preview, tests): behave like a hub, nothing hidden.
    }
  },
  reset: () => set({ access: null, loadedAt: 0 }),
}));
