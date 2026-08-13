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
const MARKETPLACE_URL = "https://market.wenzdes.com";

export async function openMarketplace(): Promise<void> {
  await open(`${MARKETPLACE_URL}/buyer`);
}
