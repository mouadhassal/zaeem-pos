import { open } from "@tauri-apps/plugin-shell";

// 2026-08-04, marketplace V3 (see apps/marketplace/PLAN.md's own "V3 --
// POS integration" section): a shortcut, not a deep sync. Opens the
// marketplace in the system browser -- a separate origin/session, not
// embedded in this app's webview -- landing straight on the buyer's
// shopping view. Logging in again there with the same account is an
// accepted cost; a cross-origin session bridge is explicitly out of
// scope until there's real usage to justify it.
//
// apps/marketplace is not deployed yet (built, not live) -- this is the
// ONE place that needs updating once it is. Everything else in this app
// stays untouched.
//
// 2026-08-13 fix: this pointed at /restaurant, a real 404 since
// marketplace's Phase B2 generalization renamed that whole route to
// /buyer (apps/marketplace/src/app/restaurant -> .../buyer) -- this was
// the one cross-app link that rename never checked, so this button has
// been silently opening a broken page ever since.
// Build-time override: VITE_MARKETPLACE_URL (e.g. a staging marketplace).
export const DEFAULT_MARKETPLACE_URL = "https://market.wenzdes.com";
export const MARKETPLACE_URL: string = (import.meta.env.VITE_MARKETPLACE_URL as string | undefined)?.replace(/\/+$/, "") || DEFAULT_MARKETPLACE_URL;

// 2026-09-13 audit fix: apps/marketplace is still "not deployed yet" per
// the note above -- market.wenzdes.com is not a live target today, so the
// "اطلب من المتجر" button that calls openMarketplace() was a live-looking
// link to a dead destination. Gate every call site behind this flag
// instead of ripping the integration out; flip it once marketplace is
// actually deployed.
export const MARKETPLACE_ENABLED = false;

export async function openMarketplace(): Promise<void> {
  await open(`${MARKETPLACE_URL}/buyer`);
}

// ECOSYSTEM_CONTRACTS.md 6.5: low-stock reorder page, optionally scoped to
// this terminal's licensed branch.
export function marketplaceReorderUrl(branchId?: string | null, baseUrl: string = MARKETPLACE_URL): string {
  const params = new URLSearchParams({ source: "pos" });
  if (branchId) params.set("branch", branchId);
  return `${baseUrl}/ar/buyer/reorder?${params.toString()}`;
}

export async function openMarketplaceReorder(branchId?: string | null): Promise<void> {
  await open(marketplaceReorderUrl(branchId));
}
