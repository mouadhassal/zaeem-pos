// Vitest runs in Node, where `window` and `localStorage` don't exist. But
// authStore.ts touches both: `isBrowserPreview` is computed at module load
// (`import.meta.env.DEV && !("__TAURI__" in window)`) and checkSession peers
// at localStorage inside its action. Without a shim, importing authStore in a
// test throws ReferenceError.
//
// The shim represents a NON-DEV **built** app: `__TAURI__` present makes
// isBrowserPreview false, so unit tests exercise the SAME verified-session
// code path a real install runs -- not the demo preview branch.
const storage = new Map<string, string>();

globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
} as unknown as Storage;

globalThis.window = { __TAURI__: {} } as unknown as Window;