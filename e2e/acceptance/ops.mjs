// Restaurant-ops acceptance on the REAL compiled POS (debug build with its own
// app identifier, so its own %APPDATA% data -- never the real install):
//   item options, kitchen stations (one slip per station), editing / gifting /
//   cancelling lines already sent, the detailed receipt, delivery end to end,
//   phone pickups (queue, kitchen timing, collect and pay, no-show), and the
//   AI menu editor (Arabic-digit prices, delete, results kept), and the order
//   history (daily numbers, search, reprint, item refund out of the drawer).
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

  await step("ui-layout", "cart lines never scroll sideways; edit/gift/delete are labelled; the whole item card is tappable", async () => {
    await b.setWindowSize(1280, 720);
    await pause(500);
    const m = await b.execute(() => {
      const line = document.querySelector('[data-testid="order-line"]');
      const box = line.parentElement;
      const pr = box.getBoundingClientRect();
      const outside = [...document.querySelectorAll('[data-testid="order-line"] button')].filter((x) => {
        const r = x.getBoundingClientRect();
        return r.left < pr.left - 1 || r.right > pr.right + 1;
      }).length;
      const tops = ['edit','gift','void'].map((k) => Math.round(line.querySelector('[data-testid="order-line-' + k + '"]').getBoundingClientRect().top));
      return { oneRow: new Set(tops).size === 1, sw: box.scrollWidth, cw: box.clientWidth, outside, edit: document.querySelector('[data-testid="order-line-edit"]').innerText, gift: document.querySelector('[data-testid="order-line-gift"]').innerText, del: document.querySelector('[data-testid="order-line-void"]').innerText };
    });
    console.log("  cart metrics:", JSON.stringify(m));
    ok(m.sw <= m.cw + 1, `cart scrolls sideways (${m.sw} > ${m.cw})`);
    eq(m.outside, 0, "buttons outside the cart panel");
    ok(m.oneRow, "edit / gift / delete share one row");
    ok(m.edit.includes("إضافات") && m.gift.includes("ضيافة") && m.del.includes("حذف"), "action labels");
    console.log("  shot:", await reg.shot("ui-cart"));
    // the pizza card carries the options badge, the drink does not; tapping the card (not the +) opens the picker
    const cards = await b.$$('[data-testid="item-card"]');
    let pizzaCard = null, colaCard = null;
    for (const c of cards) { const t = await c.getText(); if (t.includes("بيتزا مارغريتا")) pizzaCard = c; if (t.includes("كولا")) colaCard = c; }
    ok(pizzaCard && colaCard, "cards found");
    ok((await pizzaCard.getText()).includes("إضافات"), "pizza card shows the options badge");
    ok(!(await colaCard.getText()).includes("إضافات"), "cola card has no badge");
    await (await pizzaCard.$("span")).click();
    await byId("option-picker");
    console.log("  shot:", await reg.shot("ui-picker"));
    await recover();
    await until(async () => !(await exists("option-picker")), "picker closed");
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

  await step("pickup-order", "phone pickup: a name is enough, it goes to the kitchen and waits in the queue", async () => {
    await b.refresh();
    await byId("sidebar", 30000);
    await nav("pos");
    await clickId("order-type-TAKEAWAY");
    await byId("pickup-fields");
    await reg.addItem("كولا");
    await clickId("pickup-in-20");
    ok((await textOf("pickup-at")).includes("اكتب اسم الزبون"), "asks for the name before sending");
    const kitchenBefore = jobs("pizza").length + jobs("grill").length + jobs("bar").length;
    await reg.type('input[placeholder="اسم العميل"]', "سامر");
    await pause(300);
    console.log("  shot:", await reg.shot("pickup-fields"));
    await clickId("pay-send-kitchen");
    await until(async () => (await call("list_pickup_orders_v3")).length === 1, "in the pickup queue", 20000);
    const p = (await call("list_pickup_orders_v3"))[0];
    eq(p.customer_name, "سامر", "name stored");
    eq(p.customer_phone, null, "no phone needed");
    ok(p.kitchen_sent, "a pickup in 20 minutes goes to the kitchen now");
    await until(async () => jobs("pizza").length + jobs("grill").length + jobs("bar").length > kitchenBefore, "kitchen slip printed");
    await until(async () => (await textOf("pickup-count")) === "1", "queue badge shows 1");
    ids.pickupNow = p;
  });

  await step("pickup-later", "a pickup hours away waits: no kitchen slip yet", async () => {
    await clickId("order-type-TAKEAWAY");
    await reg.addItem("كولا");
    const at = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    await b.execute((v) => {
      const el = document.querySelector('input[aria-label="وقت الاستلام"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, hhmm);
    await reg.type('input[placeholder="اسم العميل"]', "ريم");
    await pause(300);
    const kitchenBefore = jobs("pizza").length + jobs("grill").length + jobs("bar").length;
    await clickId("pay-send-kitchen");
    await until(async () => (await call("list_pickup_orders_v3")).length === 2, "second pickup queued", 20000);
    const later = (await call("list_pickup_orders_v3")).find((x) => x.customer_name === "ريم");
    ok(later && !later.kitchen_sent, "held back from the kitchen");
    await pause(2500);
    eq(jobs("pizza").length + jobs("grill").length + jobs("bar").length, kitchenBefore, "no kitchen slip for a pickup two hours away");
    ids.pickupLater = later;
  });

  await step("pickup-collect", "the customer comes: collect from the queue and pay the exact total", async () => {
    const receiptsBefore = jobs("receipt").length;
    await clickId("pickup-queue-button");
    await until(async () => (await b.$$('[data-testid="pickup-row"]')).length === 2, "two rows in the queue");
    console.log("  shot:", await reg.shot("pickup-queue"));
    await clickId("pickup-collect");
    await clickId("pay-exact");
    await reg.click(/تأكيد وطباعة/);
    await until(async () => (await call("list_pickup_orders_v3")).length === 1, "collected order left the queue", 20000);
    eq((await call("list_pickup_orders_v3"))[0].customer_name, "ريم", "the later one still waits");
    await until(async () => jobs("receipt").length > receiptsBefore, "receipt printed");
  });

  await step("pickup-no-show", "never came: cancelled with a reason, listed in Reports", async () => {
    await clickId("pickup-queue-button");
    await until(async () => (await b.$$('[data-testid="pickup-row"]')).length === 1, "one row left");
    await reg.click(/^لم يحضر$/);
    await reg.type('input[placeholder^="السبب"]', "لم يرد على الهاتف");
    await pause(300);
    await reg.click(/^إلغاء الطلب$/);
    await until(async () => (await call("list_pickup_orders_v3")).length === 0, "queue empty", 20000);
    await b.keys("Escape");
    await nav("reports");
    await until(async () => (await b.$$('[data-testid="no-show-row"]')).length === 1, "no-show listed in Reports", 20000);
    ok((await textOf("no-show-report")).includes("لم يرد على الهاتف"), "reason shown");
  });

  await step("gifts-report", "the Reports screen lists the gift with its reason", async () => {
    await nav("reports");
    await until(async () => (await b.$('[data-testid="gifts-report"]')).isExisting(), "gifts section");
    // The open table order is unpaid but live; the gift counts.
    await until(async () => (await b.$$('[data-testid="gift-row"]')).length >= 1, "gift row shown", 20000);
  });
  await step("options-live", "a group created after the till was open shows up at the till without a restart", async () => {
    await nav("pos");
    await pause(500);
    await nav("menu");
    await reg.click("الإضافات");
    await clickId("options-add-group");
    await (await byId("option-group-name")).setValue("مشروبات");
    await (await byId("option-quick-input")).setValue("ثلج");
    await clickId("option-quick-without");
    // saving with no category: the card must warn
    await clickId("option-group-save");
    await until(async () => (await b.$$('[data-testid="option-group-card"]')).length === 2, "second group saved");
    ok(await exists("option-group-unlinked"), "unlinked warning shown");
    console.log("  shot:", await reg.shot("ui-options-tab"));
    const cards = await b.$$('[data-testid="option-group-card"]');
    for (const c of cards) if ((await c.getText()).includes("مشروبات")) await (await c.$('button[title="تعديل"]')).click();
    const chips = await b.$$('[data-testid="option-target-category"]');
    for (const c of chips) if ((await c.getText()).includes("مشروبات")) await c.click();
    await clickId("option-group-save");
    await until(async () => !(await exists("option-group-unlinked")), "linked");
    await nav("pos");
    await until(async () => {
      for (const c of await b.$$('[data-testid="item-card"]')) { const t = await c.getText(); if (t.includes("كولا") && t.includes("إضافات")) return true; }
      return false;
    }, "cola card now shows the badge (live, no restart)");
  });
  await step("onboarding-prices", "AI menu editor: Arabic digits type a price, delete removes the right dish, results survive leaving the page", async () => {
    const png = path.join(ROOT, ".e2e-pos", "ops-menu-photo.png");
    fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await nav("ai-onboarding");
    const fi = await b.$('input[type="file"][accept="image/*"]');
    await b.execute((el) => el.classList.remove("hidden"), fi);
    await fi.setValue(png);
    await reg.click(/^معالجة الكل$/);
    await until(async () => (await call("list_uploads")).some((u) => u.status === "DONE"), "the mock AI read the photo");
    // leave and come back: the result must still be there
    await nav("pos");
    await nav("ai-onboarding");
    await reg.click(/^تم$/);
    await reg.click(/^تعديل$/);
    const price = (await b.$$('input[type="number"]'))[0];
    eq(await price.getValue(), "500", "first draft price (cola)");
    await price.click();
    await b.keys(["Control", "a"]);
    await b.keys(["Control"]);
    await b.keys("٧٥٠٠".split(""));
    await until(async () => (await price.getValue()) === "7500", "Arabic digits typed as 7500");
    // delete the only dish of the SECOND category; it used to delete the first dish overall
    const deleted = await b.execute(() => {
      const name = [...document.querySelectorAll("input")].find((i) => i.value === "حمص باللحم");
      const row = name?.closest(".p-3");
      const del = row?.querySelector('button[title="حذف"]');
      if (!del) return false;
      del.click();
      return true;
    });
    ok(deleted, "delete button found on the hummus row");
    await until(async () => b.execute(() => ![...document.querySelectorAll("input")].some((i) => i.value === "حمص باللحم")), "hummus gone from the editor");
    ok(await b.execute(() => [...document.querySelectorAll("input")].some((i) => i.value === "كولا")), "cola still in the editor");
    const before = (await call("list_menu_items_v3")).length;
    await reg.click(/تطبيق على النظام/);
    await until(async () => (await call("list_menu_items_v3")).length > before, "draft applied");
    const items = await call("list_menu_items_v3");
    ok(items.some((i) => i.name === "كولا" && i.price_cents === 7500), "cola saved at 7500");
    ok(!items.some((i) => i.name === "حمص باللحم"), "deleted dish not created");
  });
  await step("history-refund", "order history: daily numbers, find by number, reprint a copy, refund one item from the drawer", async () => {
    // A takeaway of 2 colas, paid cash: refunding one of them is a real partial refund.
    const freshId = await call("create_full_order_v3", {
      tableId: "", orderType: "TAKEAWAY",
      items: [{ menu_item_id: ids.cola, name: null, quantity: 2, unit_price_cents: 2000, notes: null, combo_id: null, modifiers: [], comped: false, comp_reason: null }],
      subtotalCents: 4000, taxCents: 0, totalCents: 4000, discountCents: 0, discountReason: null,
      customerName: null, customerPhone: null, deliveryAddress: null, deliveryFeeCents: 0, shiftId: null, managerOverridePin: null, pickupAtMs: null,
    });
    await call("finalize_order_with_payment_v3", { orderId: freshId, method: "CASH", amountCents: 4000, changeCents: 0, debtorId: null, cardNumber: null, referenceCode: null });
    const day = await call("list_order_history_v3", { businessDate: null });
    ok(day.rows.length > 1, "today's orders are listed");
    ok(day.rows.every((r) => /^[A-D]-\d{4}$/.test(r.number ?? "")), `every order of today has a daily number: ${day.rows.map((r) => r.number).join(",")}`);
    const takeaways = day.rows.filter((r) => r.order_type === "TAKEAWAY").map((r) => r.number).sort();
    ok(takeaways.every((n, i) => n === `A-${String(i + 1).padStart(4, "0")}`), `takeaways count A-0001 up with no gap: ${takeaways.join(",")}`);
    const target = day.rows.find((r) => r.id === freshId);
    ok(target && target.status === "PAID", "the fresh order is in the history, paid");
    await nav("orders");
    await byId("history-page");
    await until(async () => (await b.$$('[data-testid="history-row"]')).length === day.rows.length, "all rows shown");
    await (await byId("history-search")).setValue(target.number);
    await until(async () => {
      const nums = await b.execute(() => [...document.querySelectorAll('[data-testid="history-number"]')].map((e) => e.textContent));
      return nums.length >= 1 && nums.includes(target.number) && nums.every((n) => n === target.number);
    }, "search by number finds that order");
    await clickId("history-row");
    await until(async () => (await textOf("detail-number")) === target.number, "detail opened");
    console.log("  shot:", await reg.shot("history-detail"));

    const receiptsBefore = jobs("receipt").length;
    await clickId("history-reprint");
    await until(async () => jobs("receipt").length > receiptsBefore, "a copy of the receipt printed");

    await clickId("history-refund");
    await byId("refund-modal");
    await clickId("refund-mode-items");
    await clickId("refund-plus");
    const amountText = await textOf("refund-amount");
    ok(!/^0\b/.test(amountText.trim()), `a refund amount is shown: ${amountText}`);
    await (await byId("refund-reason")).setValue("الطبق وصل بارداً");
    await pause(300);
    console.log("  shot:", await reg.shot("history-refund-modal"));
    await clickId("refund-confirm");
    await until(async () => !(await exists("refund-modal")), "refund done");
    await byId("detail-refunded-qty");
    const d = await call("get_order_history_detail_v3", { orderId: target.id });
    ok(d.refunded_cents > 0 && d.refunded_cents < d.total_cents, `part of the order refunded: ${d.refunded_cents} of ${d.total_cents}`);
    eq(d.refunds.length, 1, "one refund");
    eq(d.refunds[0].reason, "الطبق وصل بارداً", "reason kept");
    eq(d.refunds[0].method, "CASH", "back the way it was paid");
    eq(d.refunds[0].lines.length, 1, "one line");

    // The cash left this shift's drawer.
    await nav("shift");
    await until(async () => (await textOf("shift-cash-refunds")).length > 0, "the shift shows the cash refund");
  });
  // Settings > عام > "عدد الأصناف في كل صف": the owner picks how many item
  // cards share a row; the cards shrink to fit and nothing spills out, even
  // with a long price and an item already in the cart.
  await step("grid-density", "products per row: 5 keeps full-size cards, 7 and 10 shrink to fit, nothing spills out", async () => {
    const cat = await call("create_category_v3", { name: "حلويات", color: null, sortOrder: 0, imagePath: null });
    const prices = [1500, 2500, 12500, 125000, 3000, 4500, 99000, 6000, 7500, 800, 15000, 2200, 33000, 5000, 18000];
    for (let i = 0; i < prices.length; i++) {
      await call("create_menu_item_v3", { name: `حلوى رقم ${i + 1} بالقشطة`, categoryId: cat, priceCents: prices[i], costCents: 0, description: null, barcode: null });
    }
    // A 1920x1080 till at 125% scaling: the size the owner sees 5 per row on today.
    await b.setWindowSize(1536, 864);
    await b.refresh();
    await byId("sidebar", 30000);
    await nav("pos");
    await clickId("order-type-TAKEAWAY").catch(() => {});
    // one item in the cart, with the longest price, so its stepper shows
    const cartItem = "حلوى رقم 4 بالقشطة";
    await b.execute((nm) => {
      const card = [...document.querySelectorAll('[data-testid="item-card"]')].find((c) => c.innerText.includes(nm));
      card.click();
      card.click();
    }, cartItem);
    const measure = () =>
      b.execute((nm) => {
        const cards = [...document.querySelectorAll('[data-testid="item-card"]')];
        const top0 = Math.round(cards[0].getBoundingClientRect().top);
        const perRow = cards.filter((c) => Math.round(c.getBoundingClientRect().top) === top0).length;
        const spill = cards.filter((c) => {
          const cr = c.getBoundingClientRect();
          return c.scrollWidth > c.clientWidth + 1 || [...c.querySelectorAll("*")].some((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && (r.left < cr.left - 1 || r.right > cr.right + 1 || r.bottom > cr.bottom + 1);
          });
        }).map((c) => c.innerText.split("\n")[0]);
        const inCart = cards.find((c) => c.innerText.includes(nm));
        const r = cards[0].getBoundingClientRect();
        const qtyShown = !!inCart.querySelector('button[aria-label="تقليل"]') && [...inCart.querySelectorAll("span")].some((x) => x.children.length === 0 && x.innerText.trim() === "2");
        return { perRow, w: Math.round(r.width), h: Math.round(r.height), spill, qtyShown, inCart: !!inCart.querySelector('button[aria-label="تقليل"]'), gridW: Math.round(document.querySelector('[data-testid="menu-grid"]').getBoundingClientRect().width) };
      }, cartItem);
    const setPerRow = async (n) => {
      await nav("settings");
      await clickId(`products-per-row-${n}`);
      await nav("pos");
      await pause(600);
    };
    const auto = await measure();
    console.log("  auto:", JSON.stringify(auto));
    const seen = {};
    for (const n of [5, 7, 10]) {
      await setPerRow(n);
      seen[n] = await measure();
      console.log(`  ${n} per row:`, JSON.stringify(seen[n]));
      console.log("  shot:", await reg.shot(`grid-${n}`));
      eq(seen[n].perRow, n, `cards in the first row at ${n}`);
      eq(seen[n].spill, [], `cards with content outside them at ${n}`);
      ok(seen[n].qtyShown, `the in-cart quantity shows at ${n}`);
    }
    ok(seen[7].w < seen[5].w && seen[10].w < seen[7].w, "more per row = smaller cards");
    ok(seen[7].h < seen[5].h && seen[10].h < seen[7].h, "smaller cards are shorter too, so more rows fit");
    // the choice survives a restart of the page (kept on this device)
    await b.refresh();
    await byId("sidebar", 30000);
    await nav("pos");
    await pause(600);
    eq((await measure()).perRow, 10, "per-row choice after a reload");
    // the reload emptied the unsent cart: tap the card again, then the "−"
    // on its picture (10 per row) must take it back out
    await clickId("order-type-TAKEAWAY").catch(() => {});
    await b.execute((nm) => {
      [...document.querySelectorAll('[data-testid="item-card"]')].find((c) => c.innerText.includes(nm)).click();
    }, cartItem);
    await pause(300);
    ok((await measure()).inCart, "tapping a small card adds it");
    await b.execute((nm) => {
      const card = [...document.querySelectorAll('[data-testid="item-card"]')].find((c) => c.innerText.includes(nm));
      card.querySelector('button[aria-label="تقليل"]').click();
    }, cartItem);
    await pause(300);
    ok(!(await measure()).inCart, "the picture's − took the item back out of the cart");
    await setPerRow(0);
    eq((await measure()).perRow, auto.perRow, "back to auto");
    await b.setWindowSize(1280, 720);
  });
  // The in-app user guide (sidebar "الدليل"): written per role, searchable in
  // Arabic, and still reachable when the licence blocks the back office.
  await step("guide", "user guide: owner sees the chapters, search finds the refund steps", async () => {
    await b.setWindowSize(1366, 768);
    await nav("guide");
    await byId("guide-page");
    const chapterIds = () => b.execute(() => [...document.querySelectorAll('[data-testid^="guide-chapter-"]')].map((e) => e.dataset.testid.replace("guide-chapter-", "")));
    const owner = await chapterIds();
    console.log("  owner chapters:", owner.join(" "));
    for (const id of ["start", "shift", "selling", "menu", "settings", "reports", "troubleshoot"]) ok(owner.includes(id), `owner is missing the ${id} chapter`);
    ok(!owner.includes("kitchen") || owner.length > 10, "owner guide looks too small");
    console.log("  shot:", await reg.shot("guide-owner"));
    await (await byId("guide-search")).setValue("استرداد");
    await until(async () => (await chapterIds()).includes("history"), "search shows the history chapter");
    ok(!(await chapterIds()).includes("start"), "search should drop chapters with no match");
    await clickId("guide-chapter-history");
    await until(async () => (await reg.text()).includes("تأكيد الاسترداد"), "the refund steps are open");
    console.log("  shot:", await reg.shot("guide-search"));
    await (await byId("guide-search")).setValue("كلمةغيرموجودةأبدا");
    await until(async () => (await chapterIds()).length === 0, "nonsense search finds nothing");
    await b.refresh();
    await byId("sidebar", 30000);
  });
  // Visual tour: every sidebar screen at two common till sizes, screenshot +
  // anything wider than the window (the page must never scroll sideways).
  await step("tour", "every screen fits the window at 1366 and 1024 wide", async () => {
    const problems = [];
    for (const [w, h] of [[1366, 768], [1024, 768]]) {
      await b.setWindowSize(w, h);
      await pause(400);
      const navIds = await b.execute(() => [...document.querySelectorAll('[data-testid^="sidebar-nav-"]')].map((e) => e.getAttribute("data-testid").replace("sidebar-nav-", "")));
      for (const id of navIds) {
        await nav(id);
        await pause(1200);
        const m = await b.execute(() => {
          const vw = document.documentElement.clientWidth;
          const wide = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right <= vw + 2 && r.left >= -2) continue;
            let p = el.parentElement, clipped = false;
            while (p && p !== document.body) { const ov = getComputedStyle(p).overflowX; if (ov !== "visible") { clipped = true; break; } p = p.parentElement; }
            if (!clipped) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} [${Math.round(r.left)},${Math.round(r.right)}]`);
          }
          const scrollers = [...document.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 2 && ["auto", "scroll"].includes(getComputedStyle(e).overflowX) && e.clientWidth > 0).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)} ${e.scrollWidth}>${e.clientWidth}`);
          const errorText = /Error|undefined|NaN|\[object Object\]|تعذر/.test(document.body.innerText) ? (document.body.innerText.match(/.{0,40}(Error|undefined|NaN|\[object Object\]|تعذر).{0,60}/) || [""])[0] : "";
          return { docW: document.documentElement.scrollWidth, vw, wide: wide.slice(0, 5), scrollers: scrollers.slice(0, 5), errorText };
        });
        const shot = await reg.shot(`tour-${w}-${id}`);
        const bad = m.docW > m.vw + 2 || m.wide.length > 0 || m.errorText;
        console.log(`  ${w} ${id}: ${bad ? "CHECK" : "ok"} ${JSON.stringify({ docW: m.docW, wide: m.wide, scrollers: m.scrollers, errorText: m.errorText })} ${shot}`);
        if (bad) problems.push(`${w}/${id}`);
      }
    }
    await b.setWindowSize(1280, 720);
    ok(problems.length === 0, `screens to check: ${problems.join(", ")}`);
  });
  // Dialog tour: open each screen's main "add" dialog (and the till's pay /
  // close-shift dialogs) on a 1024x768 till and check it fits: its buttons
  // must be reachable, either on screen or inside a scrolling dialog body.
  await step("dialogs", "every main dialog fits a 1024x768 till", async () => {
    await b.setWindowSize(1024, 768);
    await pause(400);
    const problems = [];
    const check = async (label) => {
      await pause(700);
      const m = await b.execute(() => {
        const vh = window.innerHeight, vw = document.documentElement.clientWidth;
        const overlays = [...document.querySelectorAll(".fixed.inset-0")].filter((o) => o.getBoundingClientRect().height > 0);
        if (!overlays.length) return { open: false };
        const o = overlays[overlays.length - 1];
        const btns = [...o.querySelectorAll("button")].filter((x) => x.offsetParent !== null);
        const unreachable = btns.filter((x) => {
          const r = x.getBoundingClientRect();
          if (r.bottom <= vh + 1 && r.top >= -1 && r.left >= -1 && r.right <= vw + 1) return false;
          let p = x.parentElement;
          while (p && p !== o) { const st = getComputedStyle(p); if (["auto", "scroll"].includes(st.overflowY) && p.scrollHeight > p.clientHeight) return false; p = p.parentElement; }
          return true;
        }).map((x) => x.innerText.trim().slice(0, 20));
        return { open: true, unreachable };
      });
      const shot = await reg.shot(`dialog-${label}`);
      console.log(`  ${label}: ${JSON.stringify(m)} ${shot}`);
      if (!m.open) problems.push(`${label}: did not open`);
      else if (m.unreachable.length) problems.push(`${label}: unreachable ${m.unreachable.join("/")}`);
      await recover();
      await b.keys("Escape");
      await pause(300);
    };
    const clickText = async (re) => b.execute((src) => {
      const r = new RegExp(src);
      const el = [...document.querySelectorAll("button")].find((x) => x.offsetParent !== null && r.test(x.innerText.trim()));
      if (el) { el.click(); return true; }
      return false;
    }, re);
    for (const [page, re] of [["menu", "إضافة صنف"], ["staff", "إضافة موظف"], ["inventory", "إضافة مادة"], ["customers", "إضافة|عميل جديد"], ["loyalty", "إصدار بطاقة"], ["branches", "إضافة فرع"]]) {
      await nav(page);
      await pause(800);
      if (await clickText(re)) await check(page);
      else problems.push(`${page}: no add button matching ${re}`);
    }
    // the till: pay dialog with an item in the cart, then close shift
    await nav("pos");
    await clickId("order-type-TAKEAWAY").catch(() => {});
    await pause(400);
    await reg.addItem("شيش طاووق");
    await pause(300);
    if (await clickText("^دفع$")) await check("pay"); else problems.push("pay: no button");
    await nav("shift");
    if (await clickText("إغلاق الوردية")) await check("close-shift"); else problems.push("close-shift: no button");
    await b.setWindowSize(1280, 720);
    ok(problems.length === 0, problems.join(" | "));
  });

  // Items sold by weight: the owner marks shawarma "by weight" (price per kilo),
  // the cashier sells "10,000 worth" and "285 g", the cart shows each portion as
  // its own line with no stepper, the bill is exact, the order history and the
  // kitchen screen carry the weight.
  await step("weighed", "sell by weight and by amount: exact bill, no stepper, weight in history and on the kitchen screen", async () => {
    await b.setWindowSize(1366, 768);
    // Earlier steps leave items in the cart and a closed shift: start from a clean till.
    await b.refresh();
    await byId("sidebar", 30000);
    // The Menu form offers "how it is sold" and relabels the price as per kilo.
    await nav("menu");
    await reg.click(/إضافة صنف/);
    await byId("item-sold-by-weight");
    await clickId("item-sold-by-weight");
    ok((await reg.text()).includes("سعر الكيلو"), "the price field becomes the kilo price");
    console.log("  shot:", await reg.shot("menu-sold-by-weight"));
    await recover();
    await b.keys("Escape");
    await pause(300);

    ids.shawarma = await call("create_menu_item_v3", { name: "شاورما لحمة", categoryId: ids.catGrill, priceCents: 120000, costCents: 40000, description: null, barcode: null });
    await call("set_menu_item_sold_by_v3", { itemId: ids.shawarma, soldBy: "weight" });
    const listed = (await call("list_menu_items_v3")).find((i) => i.id === ids.shawarma);
    eq(listed.sold_by, "weight", "stored as sold by weight");

    await call("open_shift_v3", { startingCashCents: 0, branchId: null }).catch(() => {});
    await nav("pos");
    await clickId("order-type-TAKEAWAY");
    await pause(500);
    const tapCard = (name) => b.execute((nm) => {
      const card = [...document.querySelectorAll('[data-testid="item-card"]')].find((c) => c.innerText.includes(nm));
      if (!card) return false;
      card.click();
      return true;
    }, name);
    const cardText = await b.execute(() => [...document.querySelectorAll('[data-testid="item-card"]')].find((c) => c.innerText.includes("شاورما لحمة"))?.innerText ?? "");
    ok(cardText.includes("بالوزن") && cardText.includes("/ كغ"), `the card says it is sold by weight: ${cardText.replace(/\n/g, " ")}`);

    // 1) "give me 10,000 of it"
    ok(await tapCard("شاورما لحمة"), "tapped the shawarma card");
    await byId("weight-modal");
    const input = await byId("weight-input");
    await input.setValue("10000");
    await pause(300);
    ok((await textOf("weight-result-value")).includes("83 غ"), `10,000 buys 83 g: ${await textOf("weight-result-value")}`);
    console.log("  shot:", await reg.shot("weight-modal-amount"));
    await clickId("weight-confirm");
    await until(async () => !(await exists("weight-modal")), "dialog closed");

    // 2) "285 grams"
    ok(await tapCard("شاورما لحمة"), "tapped again");
    await byId("weight-modal");
    await clickId("weight-mode-weight");
    await (await byId("weight-input")).setValue("0.285");
    await pause(300);
    ok((await textOf("weight-result-value")).includes("34,200"), `285 g costs 34,200: ${await textOf("weight-result-value")}`);
    await clickId("weight-confirm");
    await until(async () => !(await exists("weight-modal")), "dialog closed");

    // a nonsense weight cannot be confirmed
    ok(await tapCard("شاورما لحمة"), "tapped a third time");
    await byId("weight-modal");
    await clickId("weight-mode-weight");
    await (await byId("weight-input")).setValue("0");
    await pause(300);
    ok(!(await (await byId("weight-confirm")).isEnabled()), "zero weight cannot be added");
    await reg.click(/^إلغاء$/);
    await until(async () => !(await exists("weight-modal")), "dialog cancelled");

    // The cart: two separate portions, no quantity stepper, the right total.
    const lines = await b.execute(() => [...document.querySelectorAll('[data-testid="order-line"]')].map((l) => ({ text: l.innerText.replace(/\n+/g, " | "), steppers: l.querySelectorAll('[aria-label="زيادة الكمية"]').length })));
    console.log("  cart:", JSON.stringify(lines));
    eq(lines.length, 2, "two portions are two lines");
    ok(lines[0].text.includes("83 غ") && lines[1].text.includes("285 غ"), "each line carries its weight");
    ok(lines.every((l) => l.steppers === 0), "no quantity stepper on a weighed line");
    ok((await reg.text()).includes("44,200"), "the cart total is 10,000 + 34,200");
    console.log("  shot:", await reg.shot("weighed-cart"));

    // Changing a portion before it is sent
    await b.execute(() => [...document.querySelectorAll('[data-testid="order-line-edit"]')][1]?.click());
    await byId("weight-modal");
    await (await byId("weight-input")).setValue("0.5");
    await pause(300);
    await clickId("weight-confirm");
    await until(async () => (await reg.text()).includes("500 غ") || (await reg.text()).includes("0.5"), "the portion changed");
    ok((await reg.text()).includes("70,000"), "total is now 10,000 + 60,000 = 70,000");

    // Pay: the bill is exactly what was asked for.
    const receiptsBefore = jobs("receipt").length;
    ok(await b.execute(() => { const x = [...document.querySelectorAll("button")].find((e) => e.offsetParent !== null && e.innerText.trim() === "دفع"); x?.click(); return !!x; }), "pay button");
    await byId("pay-exact");
    await clickId("pay-exact");
    await reg.click(/تأكيد وطباعة/);
    await until(async () => jobs("receipt").length > receiptsBefore, "the weighed sale printed its receipt", 20000);

    // The receipt can print a moment before the payment is committed: wait for the paid row.
    let day = await call("list_order_history_v3", { businessDate: null });
    await until(async () => { day = await call("list_order_history_v3", { businessDate: null }); return day.rows.some((r) => r.status === "PAID" && r.total_cents === 70000); }, "the 70,000 order is paid in the history");
    const sold = day.rows.find((r) => r.status === "PAID" && r.total_cents === 70000);
    ok(sold, `a paid order of exactly 70,000 is in the history: ${day.rows.map((r) => r.total_cents + ":" + r.status).join(",")}`);
    const detail = await call("get_order_history_detail_v3", { orderId: sold.id });
    const names = detail.items.map((i) => `${i.name}:${i.quantity}:${i.unit_price_cents}`);
    console.log("  history lines:", names.join(" ; "));
    ok(names.includes("شاورما لحمة — 83 غ:1:10000"), "10,000 of shawarma is 83 g, charged exactly 10,000");
    ok(names.some((n) => n.startsWith("شاورما لحمة — 500 غ:1:60000")), "500 g is 60,000");
    console.log("  shot:", await reg.shot("weighed-sold"));

    // A hand-made call cannot invent a price: the server prices the weight itself.
    const forged = await call("create_full_order_v3", {
      tableId: "", orderType: "TAKEAWAY",
      items: [{ menu_item_id: ids.shawarma, name: null, quantity: 1, unit_price_cents: 1, notes: null, combo_id: null, modifiers: [], comped: false, comp_reason: null, weight: { grams: 1000, amount_cents: 5 } }],
      subtotalCents: 1, taxCents: 0, totalCents: 1, discountCents: 0, discountReason: null,
      customerName: null, customerPhone: null, deliveryAddress: null, deliveryFeeCents: 0, shiftId: null, managerOverridePin: null, pickupAtMs: null,
    }).then(() => "accepted", (e) => String(e.message));
    ok(forged !== "accepted" && forged.includes("does not match"), `a forged amount is refused: ${forged.slice(0, 160)}`);

    // The kitchen screen shows the weight beside the name.
    const kdsOrder = await call("create_full_order_v3", {
      tableId: "", orderType: "TAKEAWAY",
      items: [{ menu_item_id: ids.shawarma, name: null, quantity: 1, unit_price_cents: 1, notes: null, combo_id: null, modifiers: [], comped: false, comp_reason: null, weight: { grams: 250 } }],
      subtotalCents: 1, taxCents: 0, totalCents: 1, discountCents: 0, discountReason: null,
      customerName: null, customerPhone: null, deliveryAddress: null, deliveryFeeCents: 0, shiftId: null, managerOverridePin: null, pickupAtMs: null,
    });
    const kds = await call("list_kitchen_orders_v3");
    const kline = kds.find((o) => o.id === kdsOrder)?.items.map((i) => i.name) ?? [];
    ok(kline.includes("شاورما لحمة — 250 غ"), `the kitchen screen shows the weight: ${JSON.stringify(kline)}`);
  });

  // Attendance: the fingerprint tab. No reader is chosen yet, so it must say so
  // plainly and refuse to enrol or punch; the late rule can be set; a manual
  // clock-in lands in the punch log.
  await step("fingerprint", "attendance tab: no-device status, late rule saved, manual clock-in logged", async () => {
    await b.setWindowSize(1366, 768);
    const staff = await call("list_staff_v3");
    const cashier = staff.find((s) => s.role === "CASHIER") ?? staff[0];
    await call("clock_in_v3", { userId: cashier.id });
    await nav("staff");
    await reg.click(/الحضور والانصراف/);
    await pause(400);
    await reg.click(/البصمة والتأخير/);
    await byId("fingerprint-panel");
    ok((await textOf("fingerprint-status")).includes("لا يوجد جهاز بصمة"), `says no reader: ${await textOf("fingerprint-status")}`);
    ok(!(await (await b.$('[data-testid="fingerprint-enrol"]')).isEnabled()), "enrolling is disabled without a reader");
    // tapping the punch button explains instead of failing silently
    await clickId("fingerprint-punch");
    await until(async () => (await reg.text()).includes("لا يوجد جهاز بصمة متصل"), "the punch button explains there is no device");

    // the late rule
    // A <time> input is a segmented 12-hour widget the driver cannot type into: set it as React sees it.
    await b.execute(() => {
      const el = document.querySelector('[data-testid="attendance-shift-start"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "10:30");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await (await byId("attendance-grace")).setValue("15");
    await clickId("attendance-settings-save");
    await until(async () => (await call("get_attendance_settings_v3")).shift_start === "10:30", "late rule saved");
    eq((await call("get_attendance_settings_v3")).late_grace_minutes, 15, "grace saved");

    // the punch log shows the manual clock-in
    await until(async () => (await b.execute(() => document.querySelector('[data-testid="punch-log"]')?.innerText ?? "")).includes("يدوي"), "the manual clock-in is in the punch log");
    console.log("  shot:", await reg.shot("fingerprint-panel"));
    const err = await call("enrol_fingerprint_v3", { userId: cashier.id, finger: "right_index" }).then(() => "", (e) => String(e.message));
    ok(err.includes("لا يوجد جهاز"), `enrolling without a reader is refused: ${err.slice(0, 120)}`);
    await call("set_attendance_settings_v3", { shiftStart: "09:00", lateGraceMinutes: 10 });
  });

  // The AI assistant page: starter questions, an answer with follow-up chips,
  // earlier turns sent back as context, a plain-Arabic error with a retry button
  // (never raw JSON), a fresh-chat button, and the rule-based insights command.
  // The debug build answers with MockAiProvider ("Mock response to: ...").
  await step("assistant", "AI page: answer + follow-ups, history sent, friendly offline error with retry, new chat, insights", async () => {
    await b.setWindowSize(1366, 768);
    await nav("ai");
    await byId("ai-chat-input");
    const msgCount = () => b.execute(() => document.querySelectorAll('[data-testid^="ai-chat-message-"]:not([data-testid$="-text"])').length);
    eq(await msgCount(), 1, "only the welcome bubble at first");
    ok((await reg.text()).includes("أسئلة سريعة"), "starter questions are shown");

    // 1) a question gets an answer, then follow-up chips appear
    await (await byId("ai-chat-input")).setValue("كم بعنا اليوم؟");
    await clickId("ai-chat-send");
    await until(async () => (await b.execute(() => document.body.innerText)).includes("Mock response to: كم بعنا اليوم؟"), "the answer arrived", 20000);
    await byId("ai-followups");
    ok(await exists("ai-chat-copy"), "an answer can be copied");

    // 2) a follow-up carries the earlier turns as context (mock echoes how many it got)
    await (await byId("ai-chat-input")).setValue("__history__");
    await clickId("ai-chat-send");
    await until(async () => (await b.execute(() => document.body.innerText)).includes("history=2"), "the follow-up was sent with the 2 earlier turns", 20000);

    // 3) a failure reads as plain Arabic with a retry button, no raw JSON / English plumbing
    await (await byId("ai-chat-input")).setValue("__offline__");
    await clickId("ai-chat-send");
    await byId("ai-chat-retry");
    const text = await b.execute(() => document.body.innerText);
    ok(text.includes("لا يوجد اتصال بالإنترنت"), "the offline message is Arabic");
    ok(!text.includes("AI unavailable") && !text.includes("AI service returned"), "no English plumbing text");
    await pause(900);
    console.log("  shot:", await reg.shot("assistant-error"));
    // a failed turn is not replayed as history
    await (await byId("ai-chat-input")).setValue("__history__");
    await clickId("ai-chat-send");
    await until(async () => (await b.execute(() => document.body.innerText)).includes("history=4"), "errors are not sent back as context (2+2 real turns)", 20000);

    // 4) new chat resets
    await clickId("ai-chat-new");
    await until(async () => (await msgCount()) === 1, "fresh chat");
    console.log("  shot:", await reg.shot("assistant-fresh"));

    // 5) the question is bounded
    const tooLong = await call("ask_assistant_v3", { question: "x".repeat(1001), startIso: "2026-01-01T00:00:00Z", endIso: "2026-12-31T00:00:00Z" }).then(() => "accepted", (e) => String(e.message));
    ok(tooLong.includes("طويل جداً"), `an over-long question is refused: ${tooLong}`);

    // 6) rule-based insights: computed on the till, no AI
    const now = new Date();
    const day = 86400000;
    const insights = await call("assistant_insights_v3", {
      tzOffsetMinutes: 0,
      periods: [
        { label: "last_7_days", start_iso: new Date(now - 6 * day).toISOString(), end_iso: now.toISOString() },
        { label: "previous_7_days", start_iso: new Date(now - 13 * day).toISOString(), end_iso: new Date(now - 6 * day - 1).toISOString() },
      ],
    });
    ok(Array.isArray(insights) && insights.every((i) => i.text && i.question && ["up", "down", "warn", "info"].includes(i.kind)), `insights are well-formed: ${JSON.stringify(insights).slice(0, 200)}`);
  });

  // Net sales and the profit views: a refund lowers sales everywhere, the
  // dashboard shows margin / expenses / net profit each with its explanation,
  // and the cost category on the Finance form says how it counts.
  await step("profit", "a refund lowers net sales; dashboard shows margin, expenses and net profit with the explanation", async () => {
    await b.setWindowSize(1366, 768);
    const tz = -new Date().getTimezoneOffset();
    const range = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return { startIso: d.toISOString(), endIso: new Date(Date.now() + 60000).toISOString(), tzOffsetMinutes: tz }; };
    const localDay = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    const before = await call("get_dashboard_summary_v3", range());

    // 2 colas (4,000) paid in cash, each costing 667 to make.
    const orderId = await call("create_full_order_v3", {
      tableId: "", orderType: "TAKEAWAY",
      items: [{ menu_item_id: ids.cola, name: null, quantity: 2, unit_price_cents: 2000, notes: null, combo_id: null, modifiers: [], comped: false, comp_reason: null }],
      subtotalCents: 4000, taxCents: 0, totalCents: 4000, discountCents: 0, discountReason: null,
      customerName: null, customerPhone: null, deliveryAddress: null, deliveryFeeCents: 0, shiftId: null, managerOverridePin: null, pickupAtMs: null,
    });
    await call("finalize_order_with_payment_v3", { orderId, method: "CASH", amountCents: 4000, changeCents: 0, debtorId: null, cardNumber: null, referenceCode: null });
    const sold = await call("get_dashboard_summary_v3", range());
    eq(sold.profit.gross_sales_cents - before.profit.gross_sales_cents, 4000, "the sale is counted");
    eq(sold.profit.cogs_cents - before.profit.cogs_cents, 1334, "cost of what was sold: 2 x 667");
    eq(sold.profit.margin_profit_cents - before.profit.margin_profit_cents, 4000 - 1334, "margin profit of the sale");

    // The refund brings net sales down; the cost of the cooked dish stays.
    const out = await call("refund_order_v3", { orderId, reason: "اختبار الاسترداد", lines: null, managerOverridePin: null });
    ok(out.amount_cents > 0, "a refund amount");
    const refunded = await call("get_dashboard_summary_v3", range());
    eq(refunded.profit.refunds_cents - before.profit.refunds_cents, out.amount_cents, "the refund is counted");
    eq(refunded.total_revenue_cents - before.total_revenue_cents, 4000 - out.amount_cents, "net sales = sold - refunded");
    eq(refunded.profit.cogs_cents - before.profit.cogs_cents, 1334, "a refunded dish still cost its food");
    const fin = await call("get_finance_revenue_v3", range());
    eq(fin.total, fin.gross - fin.refunds, "finance revenue is net of refunds");

    // Three kinds of expense: rent, ingredients, a salary.
    for (const [category, amountCents] of [["إيجار", 1500], ["مشتريات مواد", 700], ["رواتب", 500]]) {
      await call("create_operational_cost_v3", { category, amountCents, date: localDay, notes: null });
    }
    const costed = await call("get_dashboard_summary_v3", range());
    const p = (k) => costed.profit[k] - refunded.profit[k];
    eq([p("expenses_cents"), p("food_purchases_cents"), p("operating_expenses_cents"), p("salaries_cents")], [2700, 700, 2000, 500], "expense kinds");
    eq(costed.profit.expense_profit_cents, costed.profit.net_sales_cents - costed.profit.expenses_cents, "expenses way: sales minus every bill");
    eq(costed.profit.net_profit_cents, costed.profit.margin_profit_cents - costed.profit.operating_expenses_cents, "net: margin minus rent/salaries, ingredients not counted twice");
    const trend = await call("get_profit_trend_v3", range());
    eq(trend.reduce((a, d) => a + d.net_profit_cents, 0), costed.profit.net_profit_cents, "the day table adds up to the total");

    // The dashboard: net sales with its arithmetic, three profit cards, the explanation.
    // The owner starts on the dashboard: leave and come back so it loads the numbers afresh.
    await nav("shift");
    await nav("dashboard");
    await byId("profit-cards");
    ok((await textOf("profit-net-sales")).includes("المرتجعات"), `net sales shows the refunds: ${await textOf("profit-net-sales")}`);
    for (const id of ["profit-margin", "profit-expenses", "profit-net"]) await byId(id);
    ok((await textOf("profit-margin")).includes("هامش"), "the margin card shows the margin %");
    await clickId("profit-explain-toggle");
    const explainer = await textOf("profit-explainer");
    ok(explainer.includes("ساندويش كلفته 10") && explainer.includes("لا يُعدّ الدجاج مرتين"), `the explainer teaches with an example: ${explainer.slice(0, 160)}`);
    console.log("  shot:", await reg.shot("dashboard-profit"));

    // Finance: same cards, a day table with the three profits, and a hint under the cost category.
    await nav("finance");
    await byId("profit-cards");
    ok((await reg.text()).includes("صافي الربح الفعلي"), "finance shows the net profit");
    await reg.click(/^التكاليف$/);
    await reg.click(/إضافة تكلفة/);
    const select = await b.$("select");
    await b.execute((sel) => {
      const el = document.querySelector("select");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, sel);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, "مشتريات مواد");
    ok(select, "category select");
    await until(async () => (await textOf("cost-category-hint")).includes("لا تُحسب مرتين"), "the category hint explains ingredients");
    console.log("  shot:", await reg.shot("finance-cost-hint"));
    await recover();
  });

  // Payroll: the owner's guided setup, a person's pay, a month with a late day
  // and an absence, an accepted excuse, a bonus, approve and pay (which lands
  // in the expenses as salaries).
  await step("payroll", "payroll: guided rules, pay set, late/absence/excuse/bonus, approve and pay lands in expenses", async () => {
    await b.setWindowSize(1366, 768);
    const staff = await call("list_staff_v3");
    const person = staff.find((x) => x.role === "CASHIER") ?? staff[0];
    ok((await call("get_payroll_settings_v3")).configured === false, "a fresh install has no rules chosen");

    // 1) the guided setup, one question at a time
    await nav("payroll");
    await byId("rules-wizard");
    await byId("rules-days");
    await clickId("rules-next");
    await byId("rules-late");
    await clickId("late-rule-PER_MINUTE");
    await clickId("rules-next");
    await clickId("absence-rule-DAY_PAY");
    await clickId("rules-next");
    await clickId("overtime-rule-PER_HOUR");
    await clickId("rules-next");
    // the owner decides what managers may do: prepare only, for now
    await byId("rules-managers");
    await clickId("manager-access-PREPARE");
    await clickId("rules-next");
    await byId("rules-review");
    const examples = await textOf("examples");
    ok(examples.includes("تأخر 20 دقيقة") && examples.includes("غاب يوماً"), `the review shows what each rule costs: ${examples.slice(0, 200)}`);
    console.log("  shot:", await reg.shot("payroll-wizard-review"));
    await clickId("rules-save");
    await until(async () => (await call("get_payroll_settings_v3")).configured === true, "rules saved");
    const saved = await call("get_payroll_settings_v3");
    eq([saved.late_rule, saved.absence_rule, saved.overtime_rule, saved.manager_access], ["PER_MINUTE", "DAY_PAY", "PER_HOUR", "PREPARE"], "the chosen rules");

    // 2) set the person's pay in the UI
    await byId("month-tab");
    await clickId("payroll-tab-people");
    await clickId(`edit-pay-${person.id}`);
    await (await byId("pay-rate")).setValue("780000");
    await clickId("pay-save");
    await until(async () => (await call("list_payroll_employees_v3")).find((e) => e.user_id === person.id)?.pay?.rate_cents === 780000, "pay saved");

    // 3) last month: every working day on time, one day 20 minutes late, one day missing
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    const workDays = [];
    for (let d = new Date(prev); d.getMonth() === prev.getMonth(); d.setDate(d.getDate() + 1)) if (d.getDay() !== 5) workDays.push(new Date(d));
    const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const lateDay = workDays[2];
    const absentDay = workDays[4];
    const at = (d, hh, mm) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).toISOString();
    for (const d of workDays) {
      if (d === absentDay) continue;
      await call("add_manual_punch_v3", { userId: person.id, punchedAtIso: at(d, 9, d === lateDay ? 20 : 0), direction: "IN", reason: "اختبار" });
      await call("add_manual_punch_v3", { userId: person.id, punchedAtIso: at(d, 17, 0), direction: "OUT", reason: "اختبار" });
    }
    const tzNow = -new Date().getTimezoneOffset();
    const draft = await call("get_payslip_v3", { userId: person.id, month: monthKey, tzOffsetMinutes: tzNow });
    eq([draft.base_cents, draft.late_minutes, draft.late_deduction_cents, draft.absent_days, draft.absence_deduction_cents], [780000, 20, 1250, 1, 30000], "late and absent counted by the owner's rules");
    eq(draft.earned_cents, 780000 - 1250 - 30000, "earned");

    // 4) the month in the UI
    await clickId("payroll-tab-month");
    await byId("month-tab");
    await (await b.$('[aria-label="الشهر السابق"]')).click();
    await byId(`month-row-${person.id}`);
    ok((await textOf("month-label")).length > 0, "month label");
    await clickId(`open-${person.id}`);
    await byId("payslip-lines");
    let lines = await textOf("payslip-lines");
    ok(lines.includes("خصم التأخير") && lines.includes("خصم الغياب"), `the payslip explains the deductions: ${lines.slice(0, 200)}`);
    console.log("  shot:", await reg.shot("payroll-payslip"));

    // accepted excuse for the missing day: the absence deduction goes away
    await clickId(`excuse-${dayStr(absentDay)}`);
    await until(async () => !(await textOf("payslip-lines")).includes("خصم الغياب"), "the excused day is no longer deducted");
    // a bonus with a reason
    await (await byId("adj-amount")).setValue("5000");
    await (await byId("adj-reason")).setValue("أداء ممتاز");
    await clickId("adj-add");
    await until(async () => (await call("get_payslip_v3", { userId: person.id, month: monthKey, tzOffsetMinutes: tzNow })).bonus_cents === 5000, "bonus added");
    const final = await call("get_payslip_v3", { userId: person.id, month: monthKey, tzOffsetMinutes: tzNow });
    eq(final.earned_cents, 780000 - 1250 + 5000, "earned after the excuse and the bonus");

    // 5) approve, then pay: the salary lands in the expenses
    await clickId("payslip-approve");
    await until(async () => (await textOf("payslip-status")).includes("معتمد"), "approved");
    eq((await call("get_payslip_v3", { userId: person.id, month: monthKey, tzOffsetMinutes: tzNow })).status, "APPROVED", "frozen");
    const costsBefore = (await call("list_operational_costs_v3")).filter((c) => c.category === "رواتب").length;
    await clickId("payslip-pay");
    await until(async () => (await textOf("payslip-status")).includes("مصروف"), "paid");
    const salaries = (await call("list_operational_costs_v3")).filter((c) => c.category === "رواتب");
    eq(salaries.length, costsBefore + 1, "one salary expense recorded");
    ok(salaries.some((c) => c.amount_cents === 780000 - 1250 + 5000), "the earned amount is the expense");
    const today = await call("get_dashboard_summary_v3", { startIso: new Date(new Date().setHours(0, 0, 0, 0)).toISOString(), endIso: new Date(Date.now() + 60000).toISOString(), tzOffsetMinutes: tzNow });
    ok(today.profit.salaries_cents >= 780000 - 1250 + 5000, "salaries show in the profit pages");
    // a paid month cannot be reopened or changed
    const reopen = await call("reopen_payslip_v3", { payslipId: final.id ?? (await call("get_payslip_v3", { userId: person.id, month: monthKey, tzOffsetMinutes: tzNow })).id }).then(() => "", (e) => String(e.message));
    ok(reopen.includes("لا يمكن إعادة فتحه"), `a paid month cannot be reopened: ${reopen.slice(0, 100)}`);
    await recover();
    await (await b.$('[aria-label="إغلاق"]')).click().catch(() => {});

    // 6) the rules summary on the rules tab
    await clickId("payroll-tab-rules");
    await byId("rules-editor");
    ok((await textOf("rules-summary")).includes("بالدقيقة"), "the rules summary says what is chosen");
    console.log("  shot:", await reg.shot("payroll-rules"));

    // 7) the hierarchy: a manager works only on the staff under them, and only as far as the owner allowed
    const ownerToken = await b.execute(() => localStorage.getItem("zaeem_auth_token"));
    const owner = staff.find((x) => x.role === "OWNER") ?? staff[0];
    const branchId = (await call("list_branches_v3"))[0][0];
    const crew = await call("create_staff_v3", { targetBranchId: branchId, role: "CASHIER", name: "كاشير الرواتب", pin: "135790" });
    const mgr = await call("create_staff_v3", { targetBranchId: branchId, role: "MANAGER", name: "مشرف الرواتب", pin: "246810" });
    const login = await call("login_pin_v3", { pin: "246810", deviceId: "e2e-payroll" });
    const mgrToken = login.token;
    const asManager = (cmd, args = {}) => call(cmd, { sessionToken: mgrToken, ...args });
    const refused = (p) => p.then(() => "", (e) => String(e.message));
    await call("save_payroll_employee_v3", { pay: { user_id: crew, pay_type: "DAILY", rate_cents: 30000, shift_start: null, shift_minutes: null, start_date: null, end_date: null, track_attendance: false } });

    // prepare only
    let access = await asManager("get_payroll_access_v3");
    eq([access.is_owner, access.can_edit_rules, access.can_approve, access.manager_access], [false, false, false, "PREPARE"], "a manager's access");
    const seen = (await asManager("list_payroll_employees_v3")).map((e) => e.user_id);
    ok(seen.includes(crew), "the manager sees the cashier under them");
    ok(!seen.includes(owner.id) && !seen.includes(mgr), `the manager never sees the owner or themselves: ${seen.join(",")}`);
    ok((await refused(asManager("get_payroll_settings_v3"))).includes("للمالك وحده"), "the rules are the owner's");
    ok((await refused(asManager("save_payroll_employee_v3", { pay: { user_id: crew, pay_type: "DAILY", rate_cents: 1, shift_start: null, shift_minutes: null, start_date: null, end_date: null, track_attendance: false } }))).length > 0, "pay rates are the owner's");
    ok((await refused(asManager("get_payslip_v3", { userId: owner.id, month: monthKey, tzOffsetMinutes: tzNow }))).includes("خارج صلاحياتك"), "the owner's pay is out of reach");
    ok((await refused(asManager("get_payslip_v3", { userId: mgr, month: monthKey, tzOffsetMinutes: tzNow }))).includes("خارج صلاحياتك"), "a manager's own pay is out of reach");
    await asManager("add_payroll_adjustment_v3", { userId: crew, month: monthKey, kind: "BONUS", amountCents: 1000, reason: "اختبار المشرف" });
    eq((await asManager("get_payslip_v3", { userId: crew, month: monthKey, tzOffsetMinutes: tzNow })).bonus_cents, 1000, "the manager prepared a bonus");
    ok((await refused(asManager("approve_payslip_v3", { userId: crew, month: monthKey, tzOffsetMinutes: tzNow }))).includes("للمالك"), "approving is the owner's when the owner allowed preparing only");

    // the owner switches it off, then on in full
    const rules = await call("get_payroll_settings_v3");
    await call("save_payroll_settings_v3", { settings: { ...rules, manager_access: "NONE" } });
    ok((await refused(asManager("payroll_month_v3", { month: monthKey, tzOffsetMinutes: tzNow }))).includes("لم يفعّل المالك"), "switched off by the owner: the manager is told why");
    await call("save_payroll_settings_v3", { settings: { ...rules, manager_access: "FULL" } });
    access = await asManager("get_payroll_access_v3");
    eq([access.can_approve, access.can_edit_rules], [true, false], "full access lets a manager approve, never edit the rules");
    ok((await refused(asManager("get_payslip_v3", { userId: owner.id, month: monthKey, tzOffsetMinutes: tzNow }))).includes("خارج صلاحياتك"), "even with full access the owner's pay is out of reach");
    await call("save_payroll_settings_v3", { settings: { ...rules, manager_access: "PREPARE" } });
    ok(ownerToken, "owner token present");
  });

  // POS Lite (licence plan pos_lite): only the till's screens, Full-only
  // commands refused by the backend, no selling on credit or loyalty, a cash
  // sale still prints -- and putting a Full licence back brings everything
  // back without a restart.
  await step("lite", "POS Lite: till screens only, Full-only commands refused, cash sale prints, upgrade restores", async () => {
    const mint = (plan) =>
      execFileSync(process.execPath, [path.join(ROOT, "scripts/e2e/mint-pos-license.mjs"), "--key", process.env.OPS_TEST_KEY, "--tenant", "t-ops", "--branch", "b-ops", "--device", "this", "--days", "3", "--plan", plan], { encoding: "utf8" }).trim();
    await call("activate_license_v3", { activationKey: mint("pos_lite") });
    eq((await call("get_cached_license_status_v3")).plan, "pos_lite", "licence plan");
    await b.setWindowSize(1366, 768);
    await b.refresh();
    await byId("sidebar", 30000);
    const navIds = () => b.execute(() => [...document.querySelectorAll('[data-testid^="sidebar-nav-"]')].map((e) => e.dataset.testid.replace("sidebar-nav-", "")));
    const LITE = ["pos", "shift", "orders", "delivery", "customers", "menu", "kds", "staff", "guide", "settings"];
    const lite = await navIds();
    console.log("  Lite sidebar:", lite.join(" "));
    eq(lite.filter((id) => !LITE.includes(id)), [], "Full-only pages in the Lite sidebar");
    for (const id of ["pos", "shift", "orders", "delivery", "customers", "menu", "staff", "settings"]) ok(lite.includes(id), `${id} missing from the Lite sidebar`);

    // the backend refuses Full-only commands, whatever the screen shows
    for (const cmd of ["get_sales_report_v3", "get_dashboard_summary_v3", "list_debtors_v3", "list_ingredients_v3", "list_loyalty_cards_v3", "ask_assistant_v3", "list_branches_full_v3", "list_attendance_v3", "list_punches_v3", "fingerprint_status_v3", "assistant_insights_v3", "get_profit_trend_v3", "get_payroll_settings_v3", "payroll_month_v3", "add_manual_punch_v3"]) {
      const err = await call(cmd).then(() => "", (e) => String(e.message));
      ok(err.includes("POS Lite"), `${cmd} must be refused on Lite, got: ${err.slice(0, 120) || "ok"}`);
    }
    const credit = await call("take_payment_v3", { orderId: "x", method: "CREDIT", amountCents: 1, changeCents: 0, debtorId: "d" }).then(() => "", (e) => String(e.message));
    ok(credit.includes("POS Lite"), `selling on credit must be refused on Lite, got: ${credit.slice(0, 120)}`);

    // the till: no debt order type, no loyalty, no "debt" payment; a cash sale prints
    await call("open_shift_v3", { startingCashCents: 0, branchId: null }).catch(() => {});
    await nav("pos");
    ok(!(await exists("order-type-DEBT")), "no debt order type on Lite");
    await clickId("order-type-TAKEAWAY");
    await pause(400);
    const visibleButton = (text) => b.execute((t) => [...document.querySelectorAll("button")].some((x) => x.offsetParent !== null && x.innerText.trim() === t), text);
    ok(!(await visibleButton("ولاء")), "no loyalty button on Lite");
    // an item with no option groups (drinks get one in options-live)
    await reg.addItem("شيش طاووق");
    const receiptsBefore = jobs("receipt").length;
    ok(await b.execute(() => { const x = [...document.querySelectorAll("button")].find((e) => e.offsetParent !== null && e.innerText.trim() === "دفع"); x?.click(); return !!x; }), "pay button");
    await byId("pay-exact");
    ok(await visibleButton("نقدي"), "cash is offered");
    ok(!(await visibleButton("دين")), "no debt payment on Lite");
    console.log("  shot:", await reg.shot("lite-pay"));
    await clickId("pay-exact");
    await reg.click(/تأكيد وطباعة/);
    await until(async () => jobs("receipt").length > receiptsBefore, "Lite cash sale printed its receipt", 20000);

    // Menu without recipes, Staff without attendance
    await nav("staff");
    ok(!(await b.execute(() => document.body.innerText.includes("الحضور والانصراف"))), "no attendance tab on Lite");
    console.log("  shot:", await reg.shot("lite-staff"));

    // the guide on Lite: the till's chapters, none of the Full-only ones
    await nav("guide");
    await byId("guide-page");
    const guideIds = await b.execute(() => [...document.querySelectorAll('[data-testid^="guide-chapter-"]')].map((e) => e.dataset.testid.replace("guide-chapter-", "")));
    console.log("  Lite guide chapters:", guideIds.join(" "));
    for (const id of ["selling", "shift", "menu", "settings"]) ok(guideIds.includes(id), `Lite guide is missing ${id}`);
    for (const id of ["reports", "inventory", "finance", "debt", "loyalty", "ai-assistant"]) ok(!guideIds.includes(id), `Lite guide must not show ${id}`);
    ok(!(await b.execute(() => document.body.innerText.includes("البيع بالدين"))), "Lite guide must not explain debt sales");
    console.log("  shot:", await reg.shot("lite-guide"));

    // upgrade: a Full licence brings the whole sidebar back with no restart
    // (the app's 1-minute licence poll notices the plan change)
    await call("activate_license_v3", { activationKey: mint("full") });
    await until(async () => (await navIds()).includes("reports"), "Full sidebar back after the upgrade", 90000);
    ok((await navIds()).includes("debt"), "debt back after the upgrade");
  });
} finally {
  await reg.stop();
  for (const f of fakes) f.kill();
  fs.writeFileSync(path.join(ROOT, ".e2e-pos", "ops-results.json"), JSON.stringify({ results, counts: counts() }, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed; print jobs:`, JSON.stringify(counts()));
}
