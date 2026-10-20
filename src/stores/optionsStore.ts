import { create } from "zustand";
import { invoke } from "../lib/invoke";
import type { OptionGroup } from "../lib/itemOptions";

interface OptionsState {
  groups: OptionGroup[];
  loaded: boolean;
  /** Loads the active option groups once; call again after the owner edits them. */
  load: (token: string | null, force?: boolean) => Promise<void>;
}

export const useOptionsStore = create<OptionsState>((set, get) => ({
  groups: [],
  loaded: false,
  load: async (token, force = false) => {
    if (get().loaded && !force) return;
    try {
      const groups = await invoke<OptionGroup[]>("list_option_groups_v3", { sessionToken: token, includeInactive: false });
      set({ groups, loaded: true });
    } catch {
      // The till must keep selling with no options if this read ever fails.
      set({ groups: [], loaded: false });
    }
  },
}));
