// Acceptance harness: drives the REAL compiled POS (release build) through
// WebView2's WebDriver. Each "register" gets its own database folder,
// license folder and WebView2 profile, so two registers can run on one PC
// (hub + satellite). Only processes this harness starts are stopped.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..", "..", "..");
// One test build per register, each with its own identifier (so its own
// %APPDATA% data, license and WebView2 profile), never the real install.
export const appFor = (name) => path.join(ROOT, ".e2e-pos", `app-e2e-${name.toLowerCase()}.exe`);
export const dataDirFor = (name) => path.join(process.env.APPDATA, `com.wenzdes.pos.e2e.${name.toLowerCase()}`);
const webDirFor = (name) => path.join(process.env.LOCALAPPDATA, `com.wenzdes.pos.e2e.${name.toLowerCase()}`);
export const OUT = path.join(ROOT, ".e2e-pos", "runs");
const NATIVE_DRIVER = path.resolve(here, "..", "drivers", "msedgedriver.exe");
const TAURI_DRIVER = path.join(os.homedir(), ".cargo", "bin", "tauri-driver.exe");

export async function startRegister(name, { port = 4444, fresh = false, env = {} } = {}) {
  const dir = path.join(OUT, name);
  if (!/.e2e./.test(dataDirFor(name))) throw new Error("refusing to touch a non-e2e data dir");
  if (fresh) {
    fs.rmSync(dataDirFor(name), { recursive: true, force: true });
    fs.rmSync(webDirFor(name), { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  const driver = spawn(TAURI_DRIVER, ["--port", String(port), "--native-port", String(port + 100), "--native-driver", NATIVE_DRIVER], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(dir, "driver.log"), { flags: "a" });
  driver.stdout.pipe(log);
  driver.stderr.pipe(log);
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await remote({
    hostname: "127.0.0.1",
    port,
    logLevel: "error",
    capabilities: { "tauri:options": { application: appFor(name) } },
  });
  const reg = {
    name,
    dir,
    browser,
    async text() {
      return browser.execute(() => document.body.innerText);
    },
    async shot(label) {
      const f = path.join(dir, `${Date.now()}-${label}.png`);
      await browser.saveScreenshot(f);
      return f;
    },
    /** Click the first visible element whose text matches (button/link/role). */
    async click(match, { timeout = 15000 } = {}) {
      const re = match instanceof RegExp ? match : new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      await browser.waitUntil(
        async () =>
          browser.execute((src, flags) => {
            const re = new RegExp(src, flags);
            const visible = (e) => e.offsetParent !== null && !e.disabled;
            const label = (e) => (e.innerText || e.getAttribute("aria-label") || e.getAttribute("title") || "").trim();
            const els = [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=menuitem], label, li, td, div[tabindex]")];
            // Prefer real controls; fall back to the smallest element with the
            // text (e.g. clickable product tiles built from plain divs).
            const el =
              els.find((e) => re.test(label(e)) && visible(e)) ??
              [...document.querySelectorAll("div, span, p, h3, h4")]
                .filter((e) => visible(e) && re.test(label(e)))
                .sort((a, b) => label(a).length - label(b).length)[0];
            if (el) {
              el.scrollIntoView({ block: "center" });
              // Deferred so a native confirm() the click opens can't block
              // this script (accept it with reg.acceptDialog()).
              setTimeout(() => el.click(), 0);
              return true;
            }
            return false;
          }, re.source, re.flags),
        { timeout, timeoutMsg: `no clickable element matching ${re}` },
      );
      await browser.pause(300);
    },
    /** Accepts a native confirm()/alert() and returns its text. */
    async acceptDialog({ timeout = 5000 } = {}) {
      let text = "";
      await browser.waitUntil(async () => {
        try {
          text = await browser.getAlertText();
          return true;
        } catch {
          return false;
        }
      }, { timeout, timeoutMsg: "no confirm dialog appeared" });
      await browser.acceptAlert();
      await browser.pause(300);
      return text;
    },
    async waitText(match, { timeout = 20000 } = {}) {
      const re = match instanceof RegExp ? match : new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      await browser.waitUntil(async () => re.test(await reg.text()), { timeout, timeoutMsg: `text never appeared: ${re}` });
    },
    /** Types into the Nth visible input matching a CSS selector. */
    async type(selector, value, nth = 0) {
      const els = await browser.$$(selector);
      const visible = [];
      for (let i = 0; i < els.length; i++) if (await els[i].isDisplayed()) visible.push(els[i]);
      if (!visible[nth]) throw new Error(`no visible ${selector}[${nth}]`);
      await visible[nth].setValue(value);
    },
    /** Presses the "+" on the product tile whose text includes `name`. */
    async addItem(name) {
      const ok = await browser.execute((nm) => {
        const plus = [...document.querySelectorAll("button")].filter((btn) => btn.innerText.trim() === "+" && btn.offsetParent !== null);
        // The right "+" is the one whose nearest ancestor containing the
        // name is the smallest (its own tile, not the whole grid).
        let best = null;
        for (const btn of plus) {
          let box = btn.parentElement;
          for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
            if (box.innerText.includes(nm)) {
              if (!best || box.innerText.length < best.size) best = { btn, size: box.innerText.length };
              break;
            }
          }
        }
        if (!best) return false;
        best.btn.click();
        return true;
      }, name);
      if (!ok) throw new Error(`no + button for item ${name}`);
      await browser.pause(300);
    },
    /** Selects an option by visible text in the Nth visible <select>. */
    async select(text, nth = -1) {
      const els = await browser.$$("select");
      const visible = [];
      for (let i = 0; i < els.length; i++) if (await els[i].isDisplayed()) visible.push(els[i]);
      const el = visible.at(nth);
      if (!el) throw new Error("no visible select");
      await el.selectByVisibleText(text);
    },
    async stop() {
      try {
        await browser.deleteSession();
      } catch {}
      driver.kill();
    },
  };
  return reg;
}

export function cloudEnv() {
  return {
    ZAEEM_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    ZAEEM_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}
