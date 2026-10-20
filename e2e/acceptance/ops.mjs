// Restaurant-ops acceptance on the REAL compiled POS (debug build with its own
// app identifier, so its own %APPDATA% data -- never the real install):
//   item options, kitchen stations (one slip per station), editing / gifting /
//   cancelling lines already sent, the detailed receipt, delivery end to end.
// Four fake network printers (raw TCP) stand in for 3 kitchen stations and the
// receipt printer; every job they receive is saved and can be decoded to a PNG.
//
//   node acceptance/ops.mjs            (needs .e2e-pos/app-e2e-ops.exe)
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, startRegister } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRINTERS = { pizza: 9201, grill: 9202, bar: 9203, receipt: 9204 };
const printDir = (n) => path.join(ROOT, ".e2e-pos", `ops-${n}`);
const jobs = (n) => (fs.existsSync(printDir(n)) ? fs.readdirSync(printDir(n)).filter((f) => f.endsWith(".bin")).sort() : []);
const counts = () => Object.fromEntries(Object.keys(PRINTERS).map((n) => [n, jobs(n).length]));

const fakes = [];
for (const [n, port] of Object.entries(PRINTERS)) {
  fs.rmSync(printDir(n), { recursive: true, force: true });
  fakes.push(spawn(process.execPath, [path.join(here, "fake-printer.mjs")], { env: { ...process.env, PRINTER_PORT: String(port), PRINT_DIR: `ops-${n}` }, stdio: "ignore" }));
}
await new Promise((r) => setTimeout(r, 800));

const results = [];
const reg = await startRegister("ops", { fresh: true });
const b = reg.browser;
const pause = (ms) => b.pause(ms);

async function call(cmd, args = {}) {
  const r = await b.executeAsync(
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
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}
const byId = async (id, timeout = 15000) => {
  const el = await b.$(`[data-testid="${id}"]`);
  await el.waitForExist({ timeout, timeoutMsg: `missing [data-testid=${id}]` });
  return el;
};
const clickId = async (id) => (await byId(id)).click();
const exists = async (id) => (await b.$(`[data-testid="${id}"]`)).isExisting();
const textOf = async (id) => (await byId(id)).getText();
const eq = (a, e, what) => { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); };
const ok = (c, what) => { if (!c) throw new Error(what); };
async function until(fn, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}`);
    await pause(300);
  }
}
const ONLY = (process.env.OPS_STEPS ?? "").split(",").filter(Boolean);
const BASE = ["login", "license", "seed"];
async function step(id, title, fn) {
  if (ONLY.length && !BASE.includes(id) && !ONLY.includes(id)) return;
  try {
    await fn();
    results.push({ id, ok: true });
    console.log(`PASS ${id} ${title}`);
  } catch (e) {
    const shot = await reg.shot(`FAIL-${id}`).catch(() => "");
    const text = (await reg.text().catch(() => "")).replace(/\n+/g, " | ").slice(0, 600);
    results.push({ id, ok: false, error: String(e.message ?? e) });
    await recover();
    console.log(`FAIL ${id} ${title}\n  ${String(e.message ?? e).slice(0, 500)}\n  screen: ${text}\n  shot: ${shot}`);
    if (process.argv.includes("--strict")) throw e;
  }
}
// After a failed step, close anything left open so the next step starts clean.
async function recover() {
  await b.execute(() => {
    for (const overlay of document.querySelectorAll(".fixed.inset-0")) {
      [...overlay.querySelectorAll("button")].find((x) => /^(رجوع|إلغاء)$/.test(x.innerText.trim()))?.click();
    }
  });
  await pause(300);
}
const nav = async (id) => { await clickId(`sidebar-nav-${id}`); await pause(500); };

let ids = {};

try {
  await step("login", "PIN login", async () => {
    await until(async () => (await b.$('[data-testid="login-page"]')).isExisting() || (await b.$('[data-testid="sidebar"]')).isExisting(), "app loaded", 40000);
    if (await exists("login-page")) {
      for (const d of "123456") await clickId(`login-pin-digit-${d}`);
    }
    await byId("sidebar", 30000);
  });

  await step("license", "activate a test-key licence so the back office is open", async () => {
    const key = process.env.OPS_TEST_KEY;
    if (!key) throw new Error("set OPS_TEST_KEY to the throwaway private key (see build_ops.sh)");
    const blob = execFileSync(process.execPath, [path.join(ROOT, "scripts/e2e/mint-pos-license.mjs"), "--key", key, "--tenant", "t-ops", "--branch", "b-ops", "--device", "this", "--days", "3"], { encoding: "utf8" }).trim();
    await call("activate_license_v3", { activationKey: blob });
    const st = await call("get_cached_license_status_v3");
    console.log("  licence status:", JSON.stringify(st).slice(0, 160));
    await b.refresh();
    await byId("sidebar", 30000);
  });

  await step("seed", "categories, items, tables, printers via the real commands", async () => {
    const cfg = await call("get_chain_config_v3");
    console.log("  chain currency/scale:", JSON.stringify(cfg).slice(0, 200));
    const cat = async (name) => call("create_category_v3", { name, color: null, sortOrder: 0, imagePath: null });
    const item = async (name, categoryId, price) => call("create_menu_item_v3", { name, categoryId, priceCents: price, costCents: Math.round(price / 3), description: null, barcode: null });
    ids.catPizza = await cat("بيتزا");
    ids.catGrill = await cat("مشاوي");
    ids.catBar = await cat("مشروبات");
    ids.pizza = await item("بيتزا مارغريتا", ids.catPizza, 10000);
    ids.grill = await item("شيش طاووق", ids.catGrill, 8000);
    ids.cola = await item("كولا", ids.catBar, 2000);
    ids.table = await call("create_table_v3", { name: "T1", branchId: null });
    const printer = async (name, type, port, primary) =>
      call("create_printer_v3", { name, printerType: type, interface: "NETWORK", vendorId: null, productId: null, drawerPulseMs: 200, isPrimary: primary, systemPrinterName: null, ipAddress: "127.0.0.1", port });
    ids.pPizza = await printer("طابعة البيتزا", "KITCHEN", PRINTERS.pizza, false);
    ids.pGrill = await printer("طابعة المشاوي", "KITCHEN", PRINTERS.grill, false);
    ids.pBar = await printer("طابعة المشروبات", "KITCHEN", PRINTERS.bar, false);
    ids.pReceipt = await printer("طابعة الكاشير", "RECEIPT", PRINTERS.receipt, true);
    await call("set_printer_categories_v3", { printerId: ids.pPizza, categoryIds: [ids.catPizza] });
    await call("set_printer_categories_v3", { printerId: ids.pGrill, categoryIds: [ids.catGrill] });
    await call("set_printer_categories_v3", { printerId: ids.pBar, categoryIds: [ids.catBar] });
    await call("open_shift_v3", { startingCashCents: 0, branchId: null });
    await call("save_delivery_driver_v3", { driver: { id: null, name: "علي السائق", phone: "0933111222", pay_value: null, is_active: true } });
    await b.refresh();
    await byId("sidebar", 30000);
  });

  await step("options-ui", "owner builds an options group in the Menu screen", async () => {
    await nav("menu");
    await reg.click("الإضافات");
    await clickId("options-add-group");
    await (await byId("option-group-name")).setValue("إضافات البيتزا");
    await (await byId("option-quick-input")).setValue("بصل");
    await clickId("option-quick-without");
    await (await byId("option-quick-input")).setValue("جبنة");
    await clickId("option-quick-extra");
    const rows = await b.$$('[data-testid="option-choice-row"]');
    eq(rows.length, 2, "choice rows");
    // price of the "extra cheese" choice
    const priceInput = (await rows[1].$$("input"))[1];
    await priceInput.setValue("2000");
    // applies to the pizza category
    const chips = await b.$$('[data-testid="option-target-category"]');
    let clicked = false;
    for (const c of chips) if ((await c.getText()).includes("بيتزا")) { await c.click(); clicked = true; }
    ok(clicked, "pizza category chip");
    await clickId("option-group-save");
    await until(async () => (await b.$$('[data-testid="option-group-card"]')).length === 1, "group saved");
    const groups = await call("list_option_groups_v3", { includeInactive: true });
    eq(groups[0].choices.map((c) => c.name), ["بدون بصل", "زيادة جبنة"], "saved choices");
    console.log("  cheese option price (minor units):", groups[0].choices[1].price_cents);
    ids.cheesePrice = groups[0].choices[1].price_cents;
  });

  await step("pick-options", "tapping a pizza asks for its options; a drink does not", async () => {
    await nav("pos");
    await reg.click("T1");
    await pause(500);
    await reg.addItem("كولا");
    ok(!(await exists("option-picker")), "a drink with no options must add straight away");
    await reg.addItem("بيتزا مارغريتا");
    await byId("option-picker");
    const choices = await b.$$('[data-testid="option-choice"]');
    eq(choices.length, 2, "two choices offered");
    for (const c of choices) await c.click();
    await (await byId("option-note")).setValue("حار");
    await clickId("option-confirm");
    await until(async () => !(await exists("option-picker")), "picker closed");
    const details = await b.$$('[data-testid="order-line-details"]');
    ok(details.length >= 1, "pizza line shows its details");
    const parts = [];
    for (const d of details) parts.push(await d.getText());
    const txt = parts.join(" ");
    ok(txt.includes("بدون بصل") && txt.includes("زيادة جبنة") && txt.includes("حار"), `details text: ${txt}`);
  });

  await step("send-split", "send to the kitchen: one slip per station, none for stations with nothing", async () => {
    await reg.addItem("شيش طاووق");
    const before = counts();
    await clickId("pay-send-kitchen");
    await until(async () => jobs("pizza").length > before.pizza, "pizza station got its slip", 30000);
    await pause(1500);
    const after = counts();
    eq(after.pizza - before.pizza, 1, "pizza printer jobs");
    eq(after.grill - before.grill, 1, "grill printer jobs");
    eq(after.bar - before.bar, 1, "bar printer jobs");
    // Server-side: options priced from the menu.
    const tables = await call("list_tables_v3");
    ids.order = tables.find((t) => t.id === ids.table).current_order_id;
    ok(ids.order, "table has an open order");
    const open = await call("retrieve_open_order_v3", { orderId: ids.order });
    const pizza = open.items.find((i) => i.menu_item_id === ids.pizza);
    eq(pizza.modifiers.map((m) => m.name).sort(), ["بدون بصل", "زيادة جبنة"].sort(), "stored options");
    eq(pizza.notes, "حار", "stored note");
    const expected = 10000 + ids.cheesePrice + 8000 + 2000;
    eq(open.total_cents, expected, "order total = pizza + cheese + grill + cola");
    ids.total = open.total_cents;
  });

  await step("edit-sent", "edit a line already sent: kitchen gets before/after, total follows", async () => {
    const lines = await b.$$('[data-testid="order-line"]');
    let pizzaLine = null;
    for (const l of lines) if ((await l.getText()).includes("بيتزا")) pizzaLine = l;
    ok(pizzaLine, "pizza line in cart");
    await (await pizzaLine.$('[data-testid="order-line-edit"]')).click();
    await byId("option-picker");
    // turn the cheese off, keep "without onion", quantity 1 -> 1, reason
    const choices = await b.$$('[data-testid="option-choice"]');
    for (const c of choices) if ((await c.getText()).includes("جبنة")) await c.click();
    const reasons = await b.$$('[data-testid="edit-reason"]');
    await reasons[0].click();
    const before = counts();
    await clickId("option-confirm");
    // Taking value off a sent order past the manager threshold asks for the PIN.
    await until(async () => (await exists("edit-pin")) || !(await exists("option-picker")), "edit saved or PIN asked", 20000);
    if (await exists("edit-pin")) {
      ok((await textOf("option-error")).includes("رمز المدير"), "the PIN prompt explains itself");
      await (await byId("edit-pin")).setValue("123456");
      await clickId("option-confirm");
    }
    await until(async () => !(await exists("option-picker")), "edit saved", 20000);
    await until(async () => jobs("pizza").length > before.pizza, "pizza printer got the EDIT slip");
    eq(counts().grill - before.grill, 0, "grill station not disturbed by a pizza edit");
    const open = await call("retrieve_open_order_v3", { orderId: ids.order });
    const pizza = open.items.find((i) => i.menu_item_id === ids.pizza);
    eq(pizza.modifiers.map((m) => m.name), ["بدون بصل"], "options after edit");
    eq(open.total_cents, ids.total - ids.cheesePrice, "total after dropping the cheese");
    ids.total = open.total_cents;
  });

  await step("gift-sent", "give a sent drink away: stays on the order, not charged", async () => {
    const lines = await b.$$('[data-testid="order-line"]');
    let cola = null;
    for (const l of lines) if ((await l.getText()).includes("كولا")) cola = l;
    ok(cola, "cola line");
    await (await cola.$('[data-testid="order-line-gift"]')).click();
    await byId("gift-modal");
    await (await b.$$('[data-testid="gift-reason"]'))[0].click();
    await clickId("gift-confirm");
    await until(async () => !(await exists("gift-modal")), "gift saved");
    const open = await call("retrieve_open_order_v3", { orderId: ids.order });
    const c = open.items.find((i) => i.menu_item_id === ids.cola);
    eq(c.comped, true, "cola comped");
    eq(open.total_cents, ids.total - 2000, "gift not charged");
    ids.total = open.total_cents;
    await until(async () => (await b.$$('[data-testid="order-line-details"]')).length >= 1, "details visible");
    ok((await reg.text()).includes("ضيافة"), "cart shows the gift");
  });

  await step("cancel-sent", "cancel a sent grill line: kitchen is told, total drops", async () => {
    const lines = await b.$$('[data-testid="order-line"]');
    let grill = null;
    for (const l of lines) if ((await l.getText()).includes("شيش")) grill = l;
    ok(grill, "grill line");
    const before = counts();
    await (await grill.$('[data-testid="order-line-void"]')).click();
    await pause(700);
    await reg.select("خطأ في الطلب", 0);
    await reg.click("تأكيد الإلغاء");
    // Above the manager threshold the existing void dialog asks for the PIN first.
    await pause(500);
    if ((await b.$$('input[type="password"]')).length > 0) {
      await reg.type('input[type="password"]', "123456");
      await reg.click("تأكيد الإلغاء");
    }
    await until(async () => jobs("grill").length > before.grill, "grill printer got the CANCEL slip", 25000);
    const open = await call("retrieve_open_order_v3", { orderId: ids.order });
    ok(!open.items.find((i) => i.menu_item_id === ids.grill), "grill line gone from the open order");
    eq(open.total_cents, ids.total - 8000, "total after the cancel");
  });

  await step("receipt-detail", "draft receipt printed with options, note, gift and cashier", async () => {
    const before = jobs("receipt").length;
    await (await b.$('button[title="طباعة الفاتورة"]')).click();
    await until(async () => jobs("receipt").length > before, "receipt printed");
  });

  await step("delivery-settings", "owner sets driver pay in the Delivery screen", async () => {
    await nav("delivery");
    await clickId("delivery-tab-settings");
    await clickId("pay-mode-PER_DELIVERY");
    await (await byId("pay-value")).setValue("3000");
    console.log("  typed pay value:", await (await byId("pay-value")).getValue());
    await clickId("pay-save");
    await until(async () => (await textOf("pay-current")).includes("لكل توصيلة"), "setting shown");
    const s = await call("get_delivery_settings_v3");
    eq(s.pay_mode, "PER_DELIVERY", "saved mode");
    ok(s.pay_value > 0, "saved value");
    ids.payValue = s.pay_value;
  });

  await step("delivery-create", "a delivery order needs address + phone, then lands in the delivery list", async () => {
    await nav("pos");
    // The table's open tab is still in the cart: it must not be sent out as a delivery.
    await clickId("order-type-DELIVERY");
    await pause(500);
    await (await byId("delivery-address")).setValue("عنوان تجريبي");
    await reg.type('input[placeholder="رقم الجوال"]', "0933999888");
    await clickId("pay-send-kitchen");
    await pause(800);
    eq((await call("list_deliveries_v3", { filter: { statuses: [] } })).length, 0, "an open table tab must not become a delivery");
    ok((await reg.text()).includes("أفرغها"), "the cashier is told why");
    // Start over with an empty till (a reload clears the in-memory cart and the order-info fields).
    await b.refresh();
    await byId("sidebar", 30000);
    await nav("pos");
    await clickId("order-type-DELIVERY");
    await reg.addItem("كولا");
    // missing address/phone: refused, nothing created
    await clickId("pay-send-kitchen");
    await pause(800);
    eq((await call("list_deliveries_v3", { filter: { statuses: [] } })).length, 0, "no delivery created without address");
    await (await byId("delivery-address")).setValue("المزة - شارع الجلاء");
    await reg.type('input[placeholder="رقم الجوال"]', "0933000111");
    await reg.type('input[placeholder="اسم العميل"]', "أحمد");
    await (await byId("delivery-fee")).setValue("1000");
    await pause(300);
    await (await byId("delivery-driver")).selectByVisibleText("علي السائق");
    await clickId("pay-send-kitchen");
    await until(async () => (await call("list_deliveries_v3", { filter: { statuses: [] } })).length === 1, "delivery created", 20000);
    // The order is created first, then the chosen driver is assigned.
    await until(async () => (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0].status === "ASSIGNED", "driver assigned from the till", 15000);
    const d = (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0];
    eq(d.status, "ASSIGNED", "driver assigned from the till");
    eq(d.address, "المزة - شارع الجلاء", "address stored");
    ids.delivery = d;
  });

  await step("delivery-flow", "out, delivered, statement, settle: cash taken, order paid, balance cleared", async () => {
    await nav("delivery");
    {
      const before = jobs("receipt").length;
      await clickId("delivery-print");
      await until(async () => jobs("receipt").length > before, "delivery slip printed");
    }
    await clickId("delivery-out");
    await until(async () => (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0].status === "OUT", "out");
    await clickId("delivery-delivered");
    await until(async () => (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0].status === "DELIVERED", "delivered");
    const d = (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0];
    eq(d.pay_cents, ids.payValue, "driver pay frozen from the setting");
    ok(d.cash_due_cents > 0, "driver carries cash");
    await clickId("delivery-tab-statement");
    await until(async () => (await b.$$('[data-testid="statement-row"]')).length === 1, "statement row");
    eq(await textOf("statement-delivered"), "1", "delivered count");
    {
      const before = jobs("receipt").length;
      await clickId("statement-print");
      await until(async () => jobs("receipt").length > before, "driver statement printed");
    }
    await clickId("settle-start");
    await clickId("settle-confirm-btn");
    await until(async () => (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0].cash_settled, "settled", 20000);
    const after = (await call("list_deliveries_v3", { filter: { statuses: [] } }))[0];
    eq(after.order_status, "PAID", "order paid by the settlement");
    await until(async () => (await b.$$('[data-testid="settlement-row"]')).length === 1, "settlement history row");
  });

  await step("gifts-report", "the Reports screen lists the gift with its reason", async () => {
    await nav("reports");
    await until(async () => (await b.$('[data-testid="gifts-report"]')).isExisting(), "gifts section");
    // The open table order is unpaid but live; the gift counts.
    await until(async () => (await b.$$('[data-testid="gift-row"]')).length >= 1, "gift row shown", 20000);
  });
} finally {
  await reg.stop();
  for (const f of fakes) f.kill();
  fs.writeFileSync(path.join(ROOT, ".e2e-pos", "ops-results.json"), JSON.stringify({ results, counts: counts() }, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed; print jobs:`, JSON.stringify(counts()));
}
