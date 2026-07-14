import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SplashScreen from "./components/SplashScreen";
import { runMigrations } from "./db/migrations";
import { checkIntegrity, applyPragmas } from "./db/corruption";
import { createBackup, startAutoBackup } from "./lib/backup";
import { startMemoryMonitoring, measureStartup, startFpsMonitor } from "./lib/performance";
import { logger } from "./lib/logger";
import "./index.css";

const startupEnd = measureStartup();

function Root() {
  const [ready, setReady] = useState(false);
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    if (!showSplash) return;

    (async () => {
      try {
        await applyPragmas();
        logger.info("Pragmas applied");

        const integrity = await checkIntegrity();
        if (!integrity.ok) {
          logger.error("Database corruption detected", {
            errors: integrity.errors,
          });
        } else {
          logger.info("Integrity check passed");
        }

        await runMigrations();
        logger.info("Migrations complete");

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
