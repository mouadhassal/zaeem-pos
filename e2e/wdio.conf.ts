import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 2026-08-05: real UI automation for this app, not just cargo/vitest unit
// tests. Tauri v2's official approach on Windows: WebView2 already speaks
// the WebDriver protocol via msedgedriver -- `tauri-driver` is a thin
// proxy in front of it, so a normal WebdriverIO suite can drive the
// actual compiled app.exe exactly like a user would (real clicks, real
// Rust commands, real SQLite), not a mocked DOM.
const APPLICATION = path.resolve(__dirname, "..", "src-tauri", "target", "debug", "app.exe");
const NATIVE_DRIVER = path.resolve(__dirname, "drivers", "msedgedriver.exe");
const TAURI_DRIVER = path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver.exe");

if (!fs.existsSync(APPLICATION)) {
  throw new Error(
    `app.exe not found at ${APPLICATION} -- build it first: pnpm tauri build --debug --no-bundle`
  );
}

let tauriDriver: ChildProcess;

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  // No `browserName` -- tauri:options.application is what tells
  // tauri-driver which binary to launch; a browserName here would make
  // wdio try to negotiate a real browser session instead.
  capabilities: [
    {
      // @ts-expect-error -- tauri:options isn't in wdio's stock capability types
      "tauri:options": {
        application: APPLICATION,
      },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },

  // Starts once before the whole suite (maxInstances: 1, one session) --
  // spawns tauri-driver pointed at the msedgedriver.exe this repo pins
  // under e2e/drivers/ (matched to the exact WebView2 runtime version
  // installed on this machine; a mismatched driver/runtime version is the
  // most common way this class of setup silently fails to connect).
  onPrepare: () => {
    spawnSync("taskkill", ["/F", "/IM", "app.exe"], { stdio: "ignore" });
  },
  beforeSession: () => {
    tauriDriver = spawn(TAURI_DRIVER, ["--native-driver", NATIVE_DRIVER], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  afterSession: () => {
    tauriDriver?.kill();
  },
};
