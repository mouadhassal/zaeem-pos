import { create } from "zustand";
import { getCachedLicenseStatus, isPosLite, LICENSE_CHANGED_EVENT, type LicenseStatus } from "../lib/license";

export { LITE_PAGES } from "../lib/litePages";

interface PlanState {
  posLite: boolean;
  setFromStatus: (status: LicenseStatus) => void;
  load: () => Promise<void>;
}

export const usePlanStore = create<PlanState>((set) => ({
  posLite: false,
  setFromStatus: (status) => set({ posLite: isPosLite(status) }),
  load: async () => {
    try {
      set({ posLite: isPosLite(await getCachedLicenseStatus()) });
    } catch {
      // No licence state yet (first run): stays Full until one is activated.
    }
  },
}));

// Activation, renewal and the 1-minute licence poll (lib/license.ts) all
// announce here, so an upgrade or downgrade shows without a restart.
if (typeof window !== "undefined") {
  window.addEventListener(LICENSE_CHANGED_EVENT, (e) => {
    usePlanStore.getState().setFromStatus((e as CustomEvent<LicenseStatus>).detail);
  });
}
