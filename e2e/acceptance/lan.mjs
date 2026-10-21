// Two registers on one network: A becomes the hub, B joins as a second
// cashier, the hub approves it, and a sale rung up on B lands in A's
// database (and prints on A's printers).
//
// Then the "second till" proof, on the REAL compiled apps: an item created
// only on A shows on B's menu; B rings a dine-in order on a table, ADDS to
// that open order, gives one line away (ضيافة), edits another (إضافات), takes
// payment, and every row lands in A's database with the right totals; the
// kitchen slips come out of A's kitchen printer; a delivery order from B,
// with one of A's drivers, appears in A's delivery list.
//
// node acceptance/lan.mjs            (A and B already set up + licensed;
//                                     build them with build-registers.sh)
// node acceptance/lan.mjs --kitchen  (B pairs as a kitchen screen instead)
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, cloudEnv, startRegister } from "./harness.mjs";
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
const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? `\n  ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// The second-till proof. Everything on B goes through the real UI (so it
// exercises invoke.ts -> lan_relay_v3 -> the Hub's /rpc route); everything
// that is a SETUP or a CHECK on A uses A's own commands / A's database.
// ---------------------------------------------------------------------------
async function callOn(reg, cmd, args = {}) {
  const r = await reg.browser.executeAsync(
    async (cmd, args, done) => {
      try {
        const t = localStorage.getItem("zaeem_auth_token");
        done({ ok: await window.__TAURI_INTERNALS__.invoke(cmd, { sessionToken: t, ...args }) });
      } catch (e) {
        done({ err: String(e) });
      }
    },
    cmd,
    args,
  );
  if (r.err) throw new Error(`${reg.name} ${cmd}: ${r.err}`);
  return r.ok;
}
const byTestId = async (reg, id, timeout = 15000) => {
  const el = await reg.browser.$(`[data-testid="${id}"]`);
  await el.waitForExist({ timeout, timeoutMsg: `${reg.name}: missing [data-testid=${id}]` });
  return el;
};
const exists = async (reg, id) => (await reg.browser.$(`[data-testid="${id}"]`)).isExisting();
async function until(fn, what, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const ok = (c, what) => {
  if (!c) throw new Error(what);
};
const eq = (a, e, what) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};
/**
 * A register left over from an earlier day may hold an expired test licence
 * (the back office is then locked and a register cannot pair). Mint a fresh
 * one with the THROWAWAY test key the e2e builds trust (never a real key):
 * LAN_TEST_KEY (a path to that key file), default .e2e-pos/ops-test-key.pem.
 */
async function ensureLicensed(reg, tenant, branch) {
  const st = JSON.stringify(await callOn(reg, "get_cached_license_status_v3"));
  if (/Active|Grace/.test(st)) return;
  const key = process.env.LAN_TEST_KEY ?? path.join(ROOT, ".e2e-pos", "ops-test-key.pem");
  const blob = execFileSync(process.execPath, [path.join(ROOT, "scripts/e2e/mint-pos-license.mjs"), "--key", key, "--tenant", tenant, "--branch", branch, "--device", "this", "--days", "3"], { encoding: "utf8" }).trim();
  await callOn(reg, "activate_license_v3", { activationKey: blob });
  console.log(`  ${reg.name}: fresh test licence activated (was ${st.slice(0, 80)})`);
  await reg.browser.refresh();
  await reg.browser.pause(3000);
  await login(reg);
}
async function secondTillStep(id, title, fn) {
  try {
    await fn();
    check(id, true, title);
  } catch (e) {
    const shot = await B.shot(`FAIL-${id}`).catch(() => "");
    const screen = (await B.text().catch(() => "")).replace(/\n+/g, " | ").slice(0, 500);
    check(id, false, `${title}\n  ${String(e.message ?? e).slice(0, 600)}\n  B screen: ${screen}\n  shot: ${shot}`);
    throw new Error("stop");
  }
}
const lineFor = async (reg, name) => {
  for (const l of await reg.browser.$$('[data-testid="order-line"]')) if ((await l.getText()).includes(name)) return l;
  throw new Error(`no cart line containing ${name}`);
};
/** Adds a product on B; an item with options opens the picker, which is confirmed with nothing chosen. */
async function addOnB(name) {
  await B.addItem(name);
  await B.browser.pause(600);
  if (await exists(B, "option-picker")) {
    await (await byTestId(B, "option-confirm")).click();
    await until(async () => !(await exists(B, "option-picker")), "option picker closed");
  }
}
const orderRow = (orderId) => lsql("A", `select status, subtotal_cents, tax_cents, total_cents, table_id from orders where id = '${orderId}'`)[0];

async function secondTill() {
  const tag = String(Date.now()).slice(-6);
  const names = { cat1: `قسم-مركز-${tag}`, cat2: `مشروبات-مركز-${tag}`, burger: `برغر-مركز-${tag}`, cola: `كولا-مركز-${tag}`, table: `طاولة-${tag}`, driver: `سائق-${tag}`, printer: `مطبخ-${tag}` };
  const price = { burger: 5000, cola: 2000, cheese: 2000, fee: 1000 };
  const ids = {};
  const address = `المزة - شارع الجلاء ${tag}`; // unique per run: A keeps every earlier run's deliveries

  await secondTillStep("hub-setup", "A (the hub) gets a menu, option group, table, driver and a kitchen printer that B does not have", async () => {
    ids.cat1 = await callOn(A, "create_category_v3", { name: names.cat1, color: null, sortOrder: 0, imagePath: null });
    ids.cat2 = await callOn(A, "create_category_v3", { name: names.cat2, color: null, sortOrder: 1, imagePath: null });
    const item = (name, categoryId, p) => callOn(A, "create_menu_item_v3", { name, categoryId, priceCents: p, costCents: Math.round(p / 3), description: null, barcode: null });
    ids.burger = await item(names.burger, ids.cat1, price.burger);
    ids.cola = await item(names.cola, ids.cat2, price.cola);
    await callOn(A, "save_option_group_v3", {
      group: {
        id: null, name: `إضافات-${tag}`, selection: "MULTI", required: false, sort_order: 0, is_active: true,
        choices: [{ name: "زيادة جبنة", price_cents: price.cheese }],
        targets: [{ target_type: "CATEGORY", target_id: ids.cat1 }],
      },
    });
    ids.table = await callOn(A, "create_table_v3", { name: names.table, branchId: null });
    await callOn(A, "save_delivery_driver_v3", { driver: { id: null, name: names.driver, phone: "0933111222", pay_value: null, is_active: true } });
    const pr = await callOn(A, "create_printer_v3", {
      name: names.printer, printerType: "KITCHEN", interface: "NETWORK", vendorId: null, productId: null,
      drawerPulseMs: 200, isPrimary: false, systemPrinterName: null, ipAddress: "127.0.0.1", port: KITCHEN_PORT,
    });
    await callOn(A, "set_printer_categories_v3", { printerId: pr, categoryIds: [ids.cat1, ids.cat2] });
    // None of it exists in B's own database.
    eq(lsql("B", `select count(*) n from menu_items where name = '${names.burger}'`)[0].n, 0, "burger in B's own DB");
    eq(lsql("B", `select count(*) n from printers where name = '${names.printer}'`)[0].n, 0, "A's kitchen printer in B's own DB");
  });

  await secondTillStep("menu-from-hub", "an item created only on A shows on B's menu", async () => {
    await B.browser.refresh();
    await byTestId(B, "sidebar", 30000);
    await (await byTestId(B, "sidebar-nav-pos")).click();
    await B.browser.pause(1500);
    await until(async () => (await B.text()).includes(names.burger), `B's menu shows ${names.burger}`, 30000);
    await B.shot("lan-b-menu");
  });

  let orderId;
  const kitchen0 = kitchenJobs();
  await secondTillStep("b-dine-in", "B rings a dine-in order on A's table: created in A's database, kitchen slip comes out of A's printer", async () => {
    await B.click(names.table);
    await B.browser.pause(500);
    await addOnB(names.burger);
    await (await byTestId(B, "pay-send-kitchen")).click();
    orderId = await until(async () => lsql("A", `select current_order_id id from tables where id = '${ids.table}'`)[0]?.id, "table is occupied on A", 20000);
    const o = orderRow(orderId);
    eq(o.status, "PENDING", "order status on A");
    eq(o.subtotal_cents, price.burger, "subtotal on A");
    eq(lsql("B", `select count(*) n from orders where id = '${orderId}'`)[0].n, 0, "the order must not exist in B's own DB");
    await until(async () => kitchenJobs() > kitchen0, "kitchen slip reached A's kitchen printer", 30000);
  });

  await secondTillStep("b-add-items", "B ADDS a drink to the open table order (add_items_to_order over the LAN)", async () => {
    const jobs0 = kitchenJobs();
    await addOnB(names.cola);
    await (await byTestId(B, "pay-send-kitchen")).click();
    await until(async () => lsql("A", `select count(*) n from order_items where order_id = '${orderId}' and voided = 0`)[0].n === 2, "A has 2 lines", 20000);
    eq(orderRow(orderId).subtotal_cents, price.burger + price.cola, "subtotal after the addition");
    await until(async () => kitchenJobs() > jobs0, "addition slip reached A's kitchen printer", 30000);
  });

  await secondTillStep("b-gift", "B gives the drink away (ضيافة): it stays on the order, not charged", async () => {
    const line = await lineFor(B, names.cola);
    await (await line.$('[data-testid="order-line-gift"]')).click();
    await byTestId(B, "gift-modal");
    await (await B.browser.$$('[data-testid="gift-reason"]'))[0].click();
    await (await byTestId(B, "gift-confirm")).click();
    await until(async () => !(await exists(B, "gift-modal")), "gift dialog closed");
    await until(async () => lsql("A", `select count(*) n from order_items where order_id = '${orderId}' and comped = 1 and voided = 0`)[0].n === 1, "A records the comp", 20000);
    eq(orderRow(orderId).subtotal_cents, price.burger, "subtotal after the gift");
  });

  await secondTillStep("b-edit", "B edits the burger (إضافات: extra cheese): the option is priced from A's menu", async () => {
    const jobs0 = kitchenJobs();
    const line = await lineFor(B, names.burger);
    await (await line.$('[data-testid="order-line-edit"]')).click();
    await byTestId(B, "option-picker");
    for (const c of await B.browser.$$('[data-testid="option-choice"]')) if ((await c.getText()).includes("جبنة")) await c.click();
    await (await B.browser.$$('[data-testid="edit-reason"]'))[0].click();
    await (await byTestId(B, "option-confirm")).click();
    await until(async () => !(await exists(B, "option-picker")), "edit dialog closed", 20000);
    await until(async () => orderRow(orderId).subtotal_cents === price.burger + price.cheese, "A's subtotal includes the cheese", 20000);
    const mods = lsql("A", `select m.name from order_modifiers m join order_items i on i.id = m.order_item_id where i.order_id = '${orderId}' and i.voided = 0`).map((r) => r.name);
    eq(mods, ["زيادة جبنة"], "modifiers on A");
    await until(async () => kitchenJobs() > jobs0, "the edit slip reached A's kitchen printer", 30000);
  });

  await secondTillStep("b-pay", "B takes payment: the order is PAID on A and the payment equals the order total", async () => {
    await (await byTestId(B, "pay-key")).click();
    await B.browser.pause(1000);
    await B.click(/^نقدي$/);
    await (await byTestId(B, "pay-exact")).click();
    await B.click(/تأكيد وطباعة/);
    await until(async () => orderRow(orderId).status === "PAID", "order is PAID on A", 30000);
    const o = orderRow(orderId);
    eq(o.subtotal_cents, price.burger + price.cheese, "final subtotal (gift excluded, cheese included)");
    eq(o.total_cents, o.subtotal_cents + o.tax_cents, "total = subtotal + tax");
    const paid = lsql("A", `select count(*) n, coalesce(sum(amount_cents), 0) s from payments where order_id = '${orderId}'`)[0];
    eq(paid.n, 1, "one payment on A");
    eq(paid.s, o.total_cents, "payment amount = order total");
    eq(lsql("A", `select status from tables where id = '${ids.table}'`)[0].status, "FREE", "table freed on A");
    eq(lsql("B", `select count(*) n from payments where order_id = '${orderId}'`)[0].n, 0, "no payment row in B's own DB");
    await B.shot("lan-b-paid");
  });

  await secondTillStep("b-delivery", "a delivery order from B (with A's driver) appears in A's delivery list", async () => {
    await (await byTestId(B, "order-type-DELIVERY")).click();
    await addOnB(names.cola);
    await (await byTestId(B, "delivery-address")).setValue(address);
    await B.type('input[placeholder="رقم الجوال"]', "0933000111");
    await B.type('input[placeholder="اسم العميل"]', "أحمد");
    await (await byTestId(B, "delivery-fee")).setValue(String(price.fee));
    await B.browser.pause(300);
    await (await byTestId(B, "delivery-driver")).selectByVisibleText(names.driver);
    await (await byTestId(B, "pay-send-kitchen")).click();
    const row = await until(async () => {
      const list = await callOn(A, "list_deliveries_v3", { filter: { statuses: [] } });
      return list.find((d) => d.address === address && d.status === "ASSIGNED");
    }, "A's delivery list has the order, driver assigned", 30000);
    eq(row.driver_name, names.driver, "driver on A's row");
    eq(row.fee_cents, price.fee, "delivery fee on A's row");
    eq(lsql("B", `select count(*) n from order_deliveries where order_id = '${row.order_id}'`)[0].n, 0, "the delivery must not exist in B's own DB");
    // and A's own Delivery screen shows it
    await (await byTestId(A, "sidebar-nav-delivery")).click();
    await until(async () => (await A.text()).includes(address), "A's delivery screen lists it", 20000);
  });
}

// A's kitchen printer: a raw-TCP stand-in listening on this PC. Kitchen slips
// rung up on B must come out of THIS printer (A's), not B's own list.
const KITCHEN_PORT = 9221;
const kitchenDir = path.join(ROOT, ".e2e-pos", "lan-kitchen");
fs.rmSync(kitchenDir, { recursive: true, force: true });
const kitchenJobs = () => (fs.existsSync(kitchenDir) ? fs.readdirSync(kitchenDir).filter((f) => f.endsWith(".bin")).length : 0);
const fakeKitchen = spawn(process.execPath, [path.join(here, "fake-printer.mjs")], {
  env: { ...process.env, PRINTER_PORT: String(KITCHEN_PORT), PRINT_DIR: "lan-kitchen" },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const A = await startRegister("A", { port: 4444, env: cloudEnv() });
let B = await startRegister("B", { port: 4445, env: cloudEnv() });
try {
  await login(A);
  await login(B);
  await ensureLicensed(A, "t-lan", "b-lan");
  await ensureLicensed(B, "t-lan", "b-lan");

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
  if (after !== before + 1) throw new Error("stop");

  // 6. The rest of the till: menu, tables, add-to-order, gift, edit, pay,
  // kitchen printing, delivery -- all against the hub's data.
  await secondTill();
} catch (e) {
  if (e.message !== "stop") check("error", false, e.message);
} finally {
  await B.stop();
  await A.stop();
  fakeKitchen.kill();
}
console.log(JSON.stringify(results));
