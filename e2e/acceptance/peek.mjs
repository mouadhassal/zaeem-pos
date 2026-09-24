// node acceptance/peek.mjs <register> <sidebar label> [click label...]
// Logs in, opens a page, optionally clicks more labels, prints text + controls.
import { cloudEnv, startRegister } from "./harness.mjs";
import { OWNER_PIN } from "./owner.mjs";
const [name, page, ...clicks] = process.argv.slice(2);
const reg = await startRegister(name, { env: cloudEnv() });
const b = reg.browser;
try {
  await b.pause(3000);
  if (/⌫/.test(await reg.text())) for (const d of OWNER_PIN) await reg.click(new RegExp(`^${d}$`));
  await b.pause(1500);
  await reg.click(new RegExp(`^${page}$`));
  await b.pause(1500);
  for (const c of clicks) { await reg.click(new RegExp(c)); await b.pause(1200); }
  const t = await reg.text();
  const side = t.indexOf("الإعدادات\n");
  console.log(t.slice(side > 0 ? side : 0).slice(0, 3000));
  const controls = await b.execute(() => [...document.querySelectorAll("input, textarea, select, button")].filter((e) => e.offsetParent).map((e) => `${e.tagName}${e.type ? "[" + e.type + "]" : ""}:${(e.placeholder || e.getAttribute("aria-label") || e.innerText || e.value || "").trim().slice(0, 30)}`));
  console.log("CONTROLS:", controls.slice(22).join(" || "));
  console.log("SHOT", await reg.shot(`peek-${page}`));
} finally {
  await reg.stop();
}
