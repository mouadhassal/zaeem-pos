// Two registers on one network: A becomes the hub, B joins as a second
// cashier, the hub approves it, and a sale rung up on B lands in A's
// database (and prints on A's printers).
// node acceptance/lan.mjs            (A and B already set up + licensed)
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cloudEnv, startRegister } from "./harness.mjs";
import { OWNER_PIN } from "./owner.mjs";

function lsql(reg, q) {
  const db = path.join(process.env.APPDATA, `com.wenzdes.pos.e2e.${reg.toLowerCase()}`, "zaeem_pos.db");
  const py = "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(sys.argv[2])],ensure_ascii=False))";
  return JSON.parse(execFileSync("python", ["-c", py, db, q], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf8" } }));
}
const controls = (b) => b.execute(() => [...document.querySelectorAll("button, input")].filter((e) => e.offsetParent).map((e) => (e.innerText || e.placeholder || e.title || "").trim()).filter(Boolean));
async function login(reg) {
  await reg.browser.pause(4000);
  if (/⌫/.test(await reg.text())) for (const d of OWNER_PIN) await reg.click(new RegExp(`^${d}$`));
  await reg.browser.pause(2000);
}
async function networkTab(reg) {
  await reg.click(/^الإعدادات$/);
  await reg.browser.pause(1000);
  await reg.click(/^الشبكة المحلية$/);
  await reg.browser.pause(1500);
}
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? `\n  ${detail}` : ""}`);
}

const A = await startRegister("A", { port: 4444, env: cloudEnv() });
let B = await startRegister("B", { port: 4445, env: cloudEnv() });
try {
  await login(A);
  await login(B);

  // 1. A becomes the hub.
  await networkTab(A);
  if (/اجعل هذا الجهاز مركزياً/.test(await A.text())) {
    await A.click(/^اجعل هذا الجهاز مركزياً$/);
    await A.browser.pause(2500);
  }
  const aNet = await A.text();
  check("hub-mode", /مركزي/.test(aNet), aNet.slice(aNet.indexOf("الوضع الحالي"), aNet.indexOf("الوضع الحالي") + 80).replace(/\n+/g, " | "));

  // 2. B finds the hub on the network and asks to join as a register.
  await networkTab(B);
  if (/إلغاء الاتصال بهذا المركز/.test(await B.text())) {
    // Left paired by an earlier run: start from a standalone register.
    await B.click(/^إلغاء الاتصال بهذا المركز$/);
    await B.acceptDialog({ timeout: 3000 }).catch(() => {});
    await B.browser.pause(2000);
    await B.stop();
    B = await startRegister("B", { port: 4445, env: cloudEnv() });
    await login(B);
    await networkTab(B);
  }
  const kitchen = process.argv.includes("--kitchen");
  await B.click(kitchen ? /^شاشة مطبخ فقط/ : /^كاشير \/ نقطة بيع/);
  await B.click(/^البحث عن أجهزة مركزية$/);
  await B.browser.waitUntil(async () => /اتصال/.test((await controls(B.browser)).join("|")), { timeout: 30000, timeoutMsg: "B found no hub on the network" }).catch(() => {});
  const found = (await controls(B.browser)).includes("اتصال");
  check("discover", found, found ? "" : (await B.text()).slice(-400).replace(/\n+/g, " | "));
  if (!found) throw new Error("stop");
  await B.click(/^اتصال$/);
  await B.browser.pause(2500);
  const bJoin = await B.text();
  console.log("  B after join:", bJoin.slice(bJoin.indexOf("الوضع الحالي")).slice(0, 400).replace(/\n+/g, " | "));

  // 3. A approves the request.
  await networkTab(A);
  await A.browser.pause(2000);
  console.log("  A controls:", (await controls(A.browser)).slice(-8).join(" || "));
  await A.click(/^(موافقة|قبول|وافق)$/);
  await A.browser.pause(3000);
  const aAfter = await A.text();
  console.log("  A after approve:", aAfter.slice(aAfter.indexOf("طلبات اتصال")).slice(0, 300).replace(/\n+/g, " | "));

  // 4. B is connected.
  await B.browser.waitUntil(async () => /متصل ويعمل بشكل طبيعي/.test(await B.text()), { timeout: 45000 }).catch(() => {});
  const bNet = await B.text();
  check("paired", /متصل ويعمل بشكل طبيعي/.test(bNet), bNet.slice(-300).replace(/\n+/g, " | "));
  await B.shot("lan-paired");

  if (kitchen) {
    // 5k. B is the kitchen screen: it shows the hub's open orders and can
    // move one to "preparing" -- in the hub's database.
    await B.stop();
    B = await startRegister("B", { port: 4445, env: cloudEnv() });
    await login(B);
    await B.click(/^المطبخ$/);
    await B.browser.pause(3000);
    const kds = await B.text();
    const waiting = Number((kds.match(/انتظار: (\d+)/) ?? [])[1] ?? 0);
    console.log("  B kitchen screen:", (kds.match(/(انتظار|تحضير|جاهز): \d+/g) ?? []).join(" "));
    check("kds-shows-hub-orders", waiting > 0, `waiting on B's screen: ${waiting}`);
    const prepBefore = Number((kds.match(/تحضير: (\d+)/) ?? [])[1] ?? 0);
    await B.click(/^بدء التحضير$/);
    await B.browser.pause(2000);
    await B.click(/^المطبخ$/);
    await B.browser.pause(2500);
    const prepAfter = Number(((await B.text()).match(/تحضير: (\d+)/) ?? [])[1] ?? 0);
    check("kds-updates-hub", prepAfter === prepBefore + 1, `preparing ${prepBefore} -> ${prepAfter}`);
    throw new Error("stop");
  }

  // 5. A sale on B lands in A's database. (After pairing, B's staff and
  // sessions are the hub's -- sign in again.)
  const before = lsql("A", "select count(*) n from orders where status = 'PAID'")[0].n;
  if (process.argv.includes("--restart-b")) {
    await B.stop();
    B = await startRegister("B", { port: 4445, env: cloudEnv() });
  } else {
    await B.click(/^تسجيل الخروج$/).catch(() => {});
    await B.browser.pause(2000);
  }
  console.log("  B sign-in screen:", (await B.text()).slice(0, 200).replace(/\n+/g, " | "));
  await login(B);
  await B.click(/^الوردية$/);
  await B.browser.pause(1500);
  if (/بدء الوردية/.test(await B.text())) {
    await B.type("input", "50000", 0);
    await B.click(/^بدء الوردية$/);
    await B.browser.pause(1500);
  }
  await B.click(/^نقاط البيع$/);
  await B.browser.pause(1500);
  console.log("  B POS:", (await B.text()).slice(-300).replace(/\n+/g, " | "));
  await B.click(/^سفري$/).catch(() => {});
  const item = lsql("A", "select name, price_cents from menu_items where deleted_at is null order by price_cents limit 1")[0];
  await B.addItem(item.name);
  await B.click(/^دفع$/);
  await B.browser.pause(1000);
  await B.click(/^نقدي$/);
  await B.type('input[placeholder="٠"]', String(item.price_cents), 0);
  await B.click(/تأكيد وطباعة/);
  await B.browser.pause(3000);
  await B.shot("lan-sale");
  const after = lsql("A", "select count(*) n from orders where status = 'PAID'")[0].n;
  check("sale-on-hub", after === before + 1, `A paid orders ${before} -> ${after}`);
} catch (e) {
  if (e.message !== "stop") check("error", false, e.message);
} finally {
  await B.stop();
  await A.stop();
}
console.log(JSON.stringify(results));
