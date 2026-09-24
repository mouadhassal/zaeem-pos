// Scratch probe: node acceptance/probe.mjs <register> <js-module-with-default(reg)>
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cloudEnv, startRegister } from "./harness.mjs";
import { OWNER_PIN } from "./owner.mjs";
const [name, mod] = process.argv.slice(2);
const reg = await startRegister(name, { env: cloudEnv() });
const b = reg.browser;
reg.controls = () => b.execute(() => [...document.querySelectorAll("input, textarea, select, button")].filter((e) => e.offsetParent).map((e) => `${e.tagName}${e.type ? "[" + e.type + "]" : ""}:${(e.placeholder || e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText || e.value || "").trim().slice(0, 30)}`));
try {
  await b.pause(3000);
  if (/⌫/.test(await reg.text())) for (const d of OWNER_PIN) await reg.click(new RegExp(`^${d}$`));
  await b.pause(1500);
  const { default: run } = await import(pathToFileURL(path.resolve(mod)).href);
  await run(reg, b);
} catch (e) {
  console.log("PROBE ERROR", e.message);
  console.log((await reg.text()).slice(-1500));
} finally {
  await reg.stop();
}
