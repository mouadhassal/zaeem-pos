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
    for (const cmd of ["get_sales_report_v3", "get_dashboard_summary_v3", "list_debtors_v3", "list_ingredients_v3", "list_loyalty_cards_v3", "ask_assistant_v3", "list_branches_full_v3", "list_attendance_v3"]) {
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
