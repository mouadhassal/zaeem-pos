import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SplashScreen from "./components/SplashScreen";
import { createBackup, startAutoBackup } from "./lib/backup";
import { startMemoryMonitoring, measureStartup, startFpsMonitor } from "./lib/performance";
import { logger } from "./lib/logger";
import "@fontsource/tajawal/400.css";
import "@fontsource/tajawal/500.css";
import "@fontsource/tajawal/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./index.css";

// In DEV without the Tauri runtime (plain browser), `invoke()` has no Rust
// backend to talk to. To make the UI inspectable, we shim `invoke` with mock
// data so components render instead of erroring. This only runs in DEV and
// only when Tauri is absent, so production/Tauri behaviour is untouched.
if (import.meta.env.DEV && !("__TAURI__" in window)) {
  const mockInvoke = async (cmd: string): Promise<unknown> => {
    const empty: Record<string, unknown> = {
      needs_setup_v3: false,
      get_chain_config_v3: { currency: "SAR", tax_mode: "exclusive", tax_rate_cents: 1500, secondary_tax_rate_cents: 0, service_charge_rate_cents: 0, chain_name: "Zaeem", branch_name: "Demo" },
      get_receipt_config_v3: { currency: "SAR" },
      get_discount_caps_v3: { caps: { cashier_percent: 10, manager_percent: 25, owner_percent: 100 }, your_cap_percent: 10 },
      list_tables_v3: [],
      list_menu_items_v3: [],
      list_categories_v3: [],
      list_ingredients_v3: [],
      list_suppliers_v3: [],
      list_purchase_orders_v3: [],
      list_stock_movements_v3: [],
      list_low_stock_alerts_v3: [],
      list_loyalty_cards_v3: [],
      list_customers_v3: [],
      list_loyalty_transactions_v3: [],
      list_kitchen_orders_v3: [],
      list_employees_v3: [],
      list_shifts_v3: [],
      list_branches_v3: [],
      list_delivery_drivers_v3: [],
      list_delivery_zones_v3: [],
      list_debtors_v3: [],
      list_debt_records_v3: [],
      get_tax_collected_v3: 0,
      check_license_v3: { status: "active", tier: "standard" },
    };
    if (cmd in empty) return empty[cmd];
    return null;
  };
  const core = await import("@tauri-apps/api/core");
  core.invoke = mockInvoke as typeof core.invoke;
}

const startupEnd = measureStartup();

function Root() {
  const [ready, setReady] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    if (!showSplash) return;

    (async () => {
      try {
        // Pragmas, integrity checks, and migrations used to run here via a
        // SECOND SQLite connection (tauri_plugin_sql, entirely separate
        // from Rust's own). Rust's init_db() already runs its own real
        // migrations before the frontend ever loads, and applies its own
        // pragmas on its one authoritative connection -- this redundant
        // second bootstrap is gone (Batch 3b closeout), not replaced.
        await createBackup();
        startAutoBackup();
        startMemoryMonitoring();
        startFpsMonitor((fps) => {
          if (fps < 30) logger.warn("Low FPS", { fps });
        });

        startupEnd();
        setReady(true);
      } catch (err) {
        logger.error("Startup failed", { error: String(err) });
        setReady(true);
      }
    })();
  }, [showSplash]);

  if (!ready && showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} />;
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
