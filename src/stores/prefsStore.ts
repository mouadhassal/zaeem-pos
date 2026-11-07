import { create } from "zustand";
import { DEFAULT_PREFS, normalizePrefs, type Prefs } from "../lib/prefs";

// One JSON blob in this device's localStorage -- see lib/prefs.ts for why a
// device preference and not shop data.
export const PREFS_STORAGE_KEY = "zaeem_pos_prefs";

function readStored(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    return raw ? normalizePrefs(JSON.parse(raw)) : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

interface PrefsState extends Prefs {
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
}

function pickPrefs(s: PrefsState): Prefs {
  const { setPref, ...prefs } = s;
  void setPref;
  return prefs;
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  ...readStored(),
  setPref: (key, value) => {
    const next = normalizePrefs({ ...pickPrefs(get()), [key]: value });
    try {
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the choice still applies until the app restarts.
    }
    set(next);
  },
}));

/** Current prefs for non-React code (printing, services). */
export function getPrefs(): Prefs {
  return pickPrefs(usePrefsStore.getState());
}
