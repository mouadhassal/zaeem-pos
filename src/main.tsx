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
