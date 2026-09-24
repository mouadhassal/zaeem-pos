// POS acceptance run on the real compiled app (see harness.mjs).
// node acceptance/run.mjs <register A|B> <preset restaurant|retail> [--fresh] [--steps a,b,c]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, cloudEnv, startRegister } from "./harness.mjs";
import { dayFlow } from "./flow.mjs";

const KEY = process.env.E2E_SIGNING_KEY;
async function sql(q) {
  return execFileSync("docker", ["exec", "supabase_db_wz-e2e", "psql", "-U", "postgres", "-tA", "-c", q], { encoding: "utf8" }).trim();
}
function mint(device, extra = []) {
  return execFileSync("node", [path.join(ROOT, "scripts/e2e/mint-pos-license.mjs"), "--key", KEY, "--tenant", TENANT(), "--branch", BRANCH(), "--device", device, "--cloud", "--label", "كاشير " + name, ...extra], { encoding: "utf8" }).trim();
}
// Reads the register's own local SQLite (test data dir only).
function lsql(q) {
  const db = path.join(process.env.APPDATA, `com.wenzdes.pos.e2e.${name.toLowerCase()}`, "zaeem_pos.db");
  const py = "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(sys.argv[2])],ensure_ascii=False))";
  return JSON.parse(execFileSync("python", ["-c", py, db, q], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf8" } }));
}
const jobs = (dir) => {
  const d = path.join(ROOT, ".e2e-pos", dir);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const money = (n) => n.toLocaleString("en-US");
let TENANT_ID = "", BRANCH_ID = "";
const TENANT = () => TENANT_ID;
const BRANCH = () => BRANCH_ID;

const [name = "A", preset = "restaurant"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fresh = process.argv.includes("--fresh");
const only = (process.argv.find((a) => a.startsWith("--steps=")) ?? "").slice(8).split(",").filter(Boolean);
const SHOP = preset === "restaurant" ? { name: "مطعم الياسمين", branch: "فرع المزة" } : { name: "بقالة الخير", branch: "فرع الميدان" };
export const OWNER = { name: "سامي الشامي", password: "Owner-pass-2026", pin: "246810" };

const results = [];
const reg = await startRegister(name, { fresh, env: cloudEnv() });
const b = reg.browser;

async function step(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, title, ok: true, ms: Date.now() - t0 });
    console.log(`PASS ${id} ${title}`);
  } catch (e) {
    const shot = await reg.shot(`FAIL-${id}`).catch(() => "");
    const text = (await reg.text().catch(() => "")).slice(0, 1500);
    results.push({ id, title, ok: false, error: String(e.message ?? e).slice(0, 400), shot });
    console.log(`FAIL ${id} ${title}\n  ${String(e.message ?? e).slice(0, 400)}\n  screen: ${text.replace(/\n+/g, " | ").slice(0, 700)}\n  shot: ${shot}`);
    // Keep going: one broken feature should not hide the state of the rest
    // -- except the foundations everything else needs. --strict stops at
    // the first failure.
    if (process.argv.includes("--strict") || ["setup", "login", "license", "menu", "open-shift"].includes(id)) throw e;
  }
}

async function pinLogin(pin) {
  await reg.waitText(/[0-9]\s*\n?\s*[0-9]/, { timeout: 30000 });
  for (const d of pin) await reg.click(new RegExp(`^${d}$`));
}

TENANT_ID = await sql("select id from tenant where name='مطعم الشام'");
BRANCH_ID = await sql(`select id from branch where tenant_id='${TENANT_ID}' limit 1`);

try {
  await b.pause(3000);

  await step("setup", "first run: owner account, branch, business preset", async () => {
    await reg.waitText("إنشاء حساب المالك", { timeout: 30000 });
    await reg.type("input[type=text]", OWNER.name, 0);
    await reg.type("input[type=password]", OWNER.password, 0);
    await reg.type("input[type=password]", OWNER.pin, 1);
    await reg.click("التالي — بيانات الفرع");
    await reg.waitText("اسم الفرع");
    await reg.type("input[type=text]", SHOP.name, 0);
    await reg.type("input[type=text]", SHOP.branch, 1);
    await reg.click("التالي — نوع النشاط");
    await reg.waitText("نوع النشاط");
    await reg.click(preset === "restaurant" ? /مطعم/ : /بقالة/);
    await reg.click("بدء الاستخدام");
    await b.pause(2500);
    await reg.shot("after-setup");
    const [cfg] = lsql("select chain_name from chain_config");
    if (cfg.chain_name !== SHOP.name) throw new Error(`receipt header is "${cfg.chain_name}", expected the shop name`);
    const tables = lsql("select name from tables where deleted_at is null");
    if (preset === "restaurant" && tables.length < 8) throw new Error(`restaurant starts with ${tables.length} tables (expected 8)`);
  });

  await step("login", "owner signs in with the PIN", async () => {
    const txt = await reg.text();
    if (/[0-9]\n[0-9]\n[0-9]/.test(txt) || /⌫/.test(txt)) await pinLogin(OWNER.pin);
    await b.pause(2000);
    await reg.shot("after-login");
    const after = await reg.text();
    if (/⌫/.test(after)) throw new Error("still on the PIN screen");
  });
  async function openLicenseTab() {
    await reg.click(/^الإعدادات$/);
    await b.pause(1200);
    await reg.click(/^الترخيص$/);
    await b.pause(1200);
  }
  async function paste(key) {
    const box = await b.$("textarea[placeholder*=\"الصق مفتاح التفعيل\"]");
    await box.setValue(key);
    await reg.click(/^تفعيل$/);
    await b.pause(2500);
  }

  await step("license-unbound", "a trial-style key (not bound to any machine) is refused", async () => {
    TENANT_ID = await sql("select id from tenant where name='" + (preset === "restaurant" ? "مطعم الشام" : "مطعم الشام") + "'");
    BRANCH_ID = await sql("select id from branch where tenant_id='" + TENANT_ID + "' limit 1");
    // The shop pays for several registers (set by the admin when selling).
    await sql("update tenant set billed_terminal_count = 5 where id='" + TENANT_ID + "'");
    // Free this register's seat from earlier runs (an admin replacing a till).
    await sql(`update license set status = 'revoked' where tenant_id = '${TENANT_ID}' and terminal_label = 'كاشير ${name}' and status = 'active'`);
    await openLicenseTab();
    await paste(mint("none"));
    const t = await reg.text();
    const at = t.lastIndexOf("مفتاح التفعيل");
    console.log("UNBOUND RESULT:", t.slice(Math.max(0, at - 300), at + 300).replace(/\n+/g, " | "));
    await reg.shot("license-unbound");
    if (!/لا يوجد ترخيص صالح/.test(t)) throw new Error("an unbound key was ACCEPTED (expected refusal)");
  });

  await step("license", "a key bound to this Device ID activates and unlocks admin", async () => {
    await openLicenseTab();
    const deviceId = await b.execute(() => [...document.querySelectorAll("textarea")].find((e) => e.readOnly || !e.placeholder)?.value ?? "");
    if (!deviceId) throw new Error("no Device ID shown");
    await paste(mint(deviceId.trim()));
    await reg.waitText("تم تفعيل الترخيص بنجاح", { timeout: 20000 });
    await reg.waitText(/نشط/);
    await reg.shot("license-active");
  });

  await step("license-banner", "the no-license banner clears after activation", async () => {
    await reg.click(/^لوحة التحكم$/);
    await b.pause(2500);
    const t = await reg.text();
    if (/لا يوجد ترخيص صالح/.test(t)) throw new Error("banner still says no valid license after activating");
  });

  const MENU = preset === "restaurant"
    ? { cat: "مشاوي وسندويش", items: [["شاورما دجاج", 15000, 9000, ""], ["بطاطا مقلية", 8000, 3000, ""], ["كولا", 5000, 3500, "5449000000996"]] }
    : { cat: "مواد غذائية", items: [["رز مصري 1 كغ", 22000, 18000, "6281000000011"], ["زيت دوار الشمس 1 ل", 30000, 26000, "6281000000028"], ["سكر 1 كغ", 14000, 12000, "6281000000035"]] };

  await step("menu", "owner builds the menu: a category and three items with prices", async () => {
    await reg.click(/^(القائمة|المنتجات)$/);
    await reg.click(/^التصنيفات$/);
    await b.pause(800);
    if (!(await reg.text()).includes(MENU.cat)) {
      await reg.click(/إضافة تصنيف/);
      await b.pause(800);
      await reg.type("input[type=text]", MENU.cat, 0);
      await reg.click(/^حفظ$/);
      await reg.waitText(MENU.cat);
    }
    await reg.click(/^الأصناف$/);
    for (const [nm, price, cost, barcode] of MENU.items) {
      await reg.click(/إضافة صنف/);
      await b.pause(800);
      // Visible text inputs: [search, name, barcode]; numbers: [price, cost].
      await reg.type("input[type=text]", nm, 1);
      await reg.select(MENU.cat);
      await reg.type("input[type=number]", String(price), 0);
      await reg.type("input[type=number]", String(cost), 1);
      if (barcode) await reg.type("input[type=text]", barcode, 2);
      await reg.click(/^حفظ$/);
      await reg.waitText(nm);
    }
    await reg.shot("menu-built");
  });

  await step("shift-gate", "selling is blocked until a shift is open", async () => {
    await reg.click(/^نقاط البيع$/);
    await reg.waitText("لا توجد وردية مفتوحة");
  });

  await step("open-shift", "cashier opens the shift with 100,000 in the drawer", async () => {
    await reg.click(/^الوردية$/);
    await reg.waitText("الرصيد الافتتاحي");
    await reg.type("input", "100000", 0);
    await reg.click(/^بدء الوردية$/);
    await b.pause(1500);
    await reg.shot("shift-open");
    const t = await reg.text();
    if (/ابدأ الوردية/.test(t) && !/إغلاق|أغلق/.test(t)) throw new Error("shift did not open");
  });

  await step("sale-open-payment", "ring up a takeaway order and open payment", async () => {
    await reg.click(/^نقاط البيع$/);
    await b.pause(1200);
    await reg.click(/^سفري$/);
    await reg.addItem(MENU.items[0][0]);
    await reg.addItem(MENU.items[0][0]);
    await reg.addItem(MENU.items[1][0]);
    await b.pause(500);
    await reg.shot("cart");
    await reg.click(/^دفع$/);
    await b.pause(1200);
    const t = await reg.text();
    console.log("PAYMENT SCREEN:", t.slice(-1500).replace(/\n+/g, " | "));
    const controls = await b.execute(() => [...document.querySelectorAll("input, button")].filter((e) => e.offsetParent).map((e) => (e.tagName + ":" + (e.placeholder || e.innerText || "").trim()).slice(0, 40)));
    console.log("PAYMENT CONTROLS:", controls.slice(-25).join(" || "));
    await reg.shot("payment");
  });

  await step("pay-cash", "cash payment: the customer hands over more than the total and gets change", async () => {
    // Cart from the previous step: 2 x item0 + 1 x item1 (restaurant: 2x15,000 + 8,000 = 38,000).
    const total = MENU.items[0][1] * 2 + MENU.items[1][1];
    await reg.waitText(new RegExp(total.toLocaleString("en-US")));
    await reg.click(/^نقدي$/);
    const tendered = (Math.floor(total / 50000) + 1) * 50000;
    await reg.type('input[placeholder="٠"]', String(tendered), 0);
    await b.pause(500);
    const t = await reg.text();
    const change = (tendered - total).toLocaleString("en-US");
    if (!t.includes(change)) throw new Error("change " + change + " not shown; screen tail: " + t.slice(-400).replace(/\n+/g, " | "));
    await reg.click(/تأكيد وطباعة/);
    await b.pause(2500);
    await reg.shot("after-pay");
    const after = await reg.text();
    console.log("AFTER PAY:", after.slice(-700).replace(/\n+/g, " | "));
  });

  async function addPrinter({ label, kind, usbName, ip, port = "9100" }) {
    await reg.click(/^الإعدادات$/);
    await reg.click(/^الطابعة$/);
    await b.pause(800);
    if ((await reg.text()).includes(label)) return;
    await reg.click(/إضافة طابعة/);
    await b.pause(600);
    await reg.type('input[placeholder^="اسم الطابعة"]', label, 0);
    await reg.click(new RegExp(`^${kind}$`));
    if (ip) {
      await reg.click(/^شبكة \(IP\)$/);
      await reg.type('input[placeholder^="عنوان IP"]', ip, 0);
      await reg.type("input[type=number]", port, 0);
    } else {
      await reg.click(/^USB$/);
      await reg.select(usbName);
    }
    await reg.click(/^إضافة$/);
    await reg.waitText(label);
  }

  await step("printers", "add printers: receipt (network), kitchen (network), and the USB XP-58", async () => {
    // Receipts go to a fake LAN printer on 9101 so every receipt can be
    // read back; the physical XP-58 is added too (spooler path, 58mm).
    await addPrinter({ label: "طابعة الإيصالات", kind: "إيصال", ip: "127.0.0.1", port: "9101" });
    if (preset === "restaurant") await addPrinter({ label: "طابعة المطبخ", kind: "مطبخ", ip: "127.0.0.1" });
    await addPrinter({ label: "طابعة XP-58", kind: "إيصال", usbName: "XP-58 (copy 1)" });
    await reg.shot("printers");
    const xp = lsql("select paper_width_mm from printers where system_printer_name like 'XP-58%'")[0];
    if (xp?.paper_width_mm !== 58) throw new Error(`XP-58 added with paper width ${xp?.paper_width_mm}mm (a 58mm printer would cut receipts)`);
  });

  await dayFlow({ reg, b, step, lsql, sql, jobs, money, MENU, OWNER, preset, TENANT_ID });

  await step("explore-settings", "look at settings (exploration)", async () => {
    await reg.click(/^الإعدادات$/);
    await b.pause(1500);
    await reg.click(/^الترخيص$/);
    await b.pause(1500);
    const t = await reg.text();
    console.log("LICENSE TAB:", t.slice(t.indexOf("عن النظام") + 9, t.indexOf("عن النظام") + 1500));
    const inputs = await b.execute(() => [...document.querySelectorAll("input, textarea, button")].filter((e) => e.offsetParent).map((e) => e.tagName + ":" + (e.placeholder || e.innerText || "").slice(0, 40)));
    console.log("CONTROLS:", inputs.slice(-15).join(" || "));
    await reg.shot("license-tab");
  });
} finally {
  fs.mkdirSync(reg.dir, { recursive: true });
  fs.writeFileSync(path.join(reg.dir, `results-${preset}.json`), JSON.stringify(results, null, 2));
  console.log((await reg.text().catch(() => "")).slice(0, 1200));
  await reg.stop();
}
