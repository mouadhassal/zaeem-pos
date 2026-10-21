// First launch of a brand-new install (release build, empty data): walks the
// setup steps a new customer sees and screenshots each one.
// node acceptance/firstrun.mjs   (needs .e2e-pos/app-e2e-fr.exe, see build-registers.sh)
import { startRegister } from "./harness.mjs";

const reg = await startRegister("FR", { fresh: true, port: 4460 });
const b = reg.browser;
const screen = async (label) => {
  const txt = (await reg.text()).replace(/\n+/g, " | ").slice(0, 500);
  const buttons = await b.execute(() => [...document.querySelectorAll("button")].filter((x) => x.offsetParent).map((x) => (x.disabled ? "~" : "") + x.innerText.trim()).filter(Boolean));
  console.log(`SCREEN ${label}: ${txt}\n  buttons: ${JSON.stringify(buttons.slice(0, 16))}\n  shot: ${await reg.shot(`firstrun-${label}`)}`);
};
const fill = async (sel, v) => { const el = await b.$(sel); await el.waitForExist({ timeout: 10000 }); await el.setValue(v); };
try {
  await b.setWindowSize(1366, 768);
  await b.pause(6000);
  await screen("1-owner");
  const inputs = await b.$$("input");
  await inputs[0].setValue("صاحب المطعم");
  await inputs[1].setValue("Password-1234");
  await inputs[2].setValue("246810");
  await b.pause(300);
  await reg.click(/التالي/);
  await b.pause(2500);
  await screen("2-branch");
  const inputs2 = await b.$$("input");
  for (let i = 0; i < inputs2.length; i++) {
    const el = inputs2[i];
    const ph = (await el.getAttribute("placeholder")) ?? "";
    const type = await el.getAttribute("type");
    if (type === "checkbox" || type === "radio" || type === "file") continue;
    if (!(await el.getValue())) await el.setValue(/هاتف|جوال/.test(ph) ? "0933000000" : "مطعم التجربة");
  }
  await b.pause(300);
  await screen("2b-branch-filled");
  for (let step = 3; step < 7; step++) {
    // Always the forward button ("التالي" / finish), never "skip".
    const clicked = await b.execute(() => {
      const btn = [...document.querySelectorAll("button")].find((x) => x.offsetParent && !x.disabled && /التالي|ابدأ|بدء|إنهاء|حفظ|متابعة/.test(x.innerText) && !/تخطي/.test(x.innerText));
      if (btn) { btn.click(); return btn.innerText.trim(); }
      return null;
    });
    await b.pause(3000);
    await screen(`${step}-after-${(clicked ?? "none").slice(0, 12)}`);
    if (!clicked) break;
  }
  // a brand-new install has no licence: the locked screen must lead to activation
  const act = await b.$('[data-testid="locked-activate"]');
  if (await act.isExisting()) {
    await act.click();
    await b.pause(2000);
    await screen("8-activate");
    await reg.click(/^نقاط البيع$/);
    await b.pause(2500);
    await screen("9-till");
  } else {
    console.log("NO locked-activate button on the first screen");
  }
} finally {
  await reg.stop();
}
