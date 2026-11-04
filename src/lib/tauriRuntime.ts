/**
 * True inside the real app window. Tauri 2 always puts `__TAURI_INTERNALS__` on
 * `window`; `__TAURI__` only exists when `app.withGlobalTauri` is on, and this
 * app does not use it. The updater used to test `__TAURI__` and so returned early
 * on every till: it never checked for an update, and the Settings button said
 * "updates unavailable in preview mode". A plain browser (dev preview) has neither.
 */
export function isTauriRuntime(w: object = window): boolean {
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w;
}
