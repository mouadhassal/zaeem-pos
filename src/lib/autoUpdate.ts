import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { logger } from "./logger";

/**
 * 2026-07-27, shipping day: silent, no-prompt update check -- runs once at
 * cold boot, before the splash screen hands off to the real app. If a
 * signed newer build is available (see apps/control's /api/updates route
 * and the app_release table), it's downloaded and installed, then the app
 * relaunches on its own straight into the new version. The cashier never
 * sees a dialog or has to do anything; the only visible effect is the
 * splash screen taking a little longer than usual, once, on whichever
 * boot the update lands on. Every other terminal on every other branch
 * picks up the same update the same way, independently, the next time
 * each of them is cold-booted -- no manual reinstall anywhere.
 */
export async function checkForUpdatesSilently(): Promise<void> {
  if (!("__TAURI__" in window)) return; // dev-in-browser has no updater backend
  try {
    const update = await check();
    if (!update) return;
    logger.info("Update found, installing silently", { version: update.version });
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // Never block startup on a failed/unreachable update check (no
    // internet, server down, etc.) -- the POS must still open and work
    // with whatever version is already installed.
    logger.warn("Update check failed (non-fatal)", { error: String(err) });
  }
}
