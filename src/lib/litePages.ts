/**
 * POS Lite (licence plan "pos_lite"): the till only. These are the sidebar
 * screens it keeps; every other page is Full-only. The real enforcement is
 * in Rust (src-tauri/src/plan_gate.rs refuses the Full-only commands); this
 * only hides what would be refused.
 */
export const LITE_PAGES: ReadonlySet<string> = new Set([
  "pos", "shift", "orders", "delivery", "customers", "menu", "kds", "staff", "guide", "settings",
]);
