// The day-in-the-life part of the acceptance run: printing, dine-in with
// the kitchen, voids, credit (دين), refunds, closing the shift, reports
// and cloud sync. Called from run.mjs with its helpers.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./harness.mjs";

export async function dayFlow({ reg, b, step, lsql, sql, jobs, money, MENU, OWNER, preset, TENANT_ID }) {
  const restaurant = preset === "restaurant";

  async function pay(amount) {
    await reg.click(/^دفع$/);
    await b.pause(1000);
    await reg.click(/^نقدي$/);
    await reg.type('input[placeholder="٠"]', String(amount), 0);
    await reg.click(/تأكيد وطباعة/);
    await b.pause(3500);
  }

  await step("sale-printed", "a paid takeaway prints a kitchen ticket and a receipt", async () => {
    const k0 = jobs("prints").length, r0 = jobs("receipts").length;
    await reg.click(/^نقاط البيع$/);
    await b.pause(1000);
    if (restaurant) await reg.click(/^سفري$/);
    await reg.addItem(MENU.items[2][0]);
    await reg.addItem(MENU.items[0][0]);
    await pay(MENU.items[2][1] + MENU.items[0][1]);
    await reg.shot("after-printed-sale");
    const k = jobs("prints").length - k0, r = jobs("receipts").length - r0;
    console.log(`  kitchen tickets: ${k}, receipts: ${r}`);
    if (restaurant && k < 1) throw new Error("no kitchen ticket reached the kitchen printer");
    if (r < 1) throw new Error("no receipt reached the receipt printer");
  });

  if (!restaurant) {
    await step("barcode-sale", "retail: scanning two barcodes rings them up; cash sale", async () => {
      const r0 = jobs("receipts").length;
      await reg.click(/^نقاط البيع$/);
      await b.pause(1000);
      await b.execute(() => document.activeElement?.blur());
      // A USB scanner is a keyboard: the digits then Enter, very fast.
      for (const [, , , code] of MENU.items.slice(0, 2)) await b.keys([...code, "Enter"]);
      await b.pause(800);
      const due = MENU.items[0][1] + MENU.items[1][1];
      await reg.waitText(money(due));
      await pay(due);
      if (jobs("receipts").length - r0 < 1) throw new Error("no receipt printed");
    });
  }

  if (restaurant) {
    await step("dine-in-kitchen", "dine-in: seat table 3, send the order to the kitchen (no payment yet)", async () => {
      const k0 = jobs("prints").length;
      await reg.click(/^نقاط البيع$/);
      await b.pause(1000);
      await reg.click(/^صالة$/);
      await reg.click(/^3$/);
      await b.pause(800);
      await reg.addItem(MENU.items[0][0]);
      await reg.addItem(MENU.items[0][0]);
      await reg.addItem(MENU.items[1][0]);
      await reg.click(/^إرسال للمطبخ$/);
      await b.pause(3000);
      if (jobs("prints").length - k0 < 1) throw new Error("send-to-kitchen printed nothing");
      const open = lsql("select status, total_cents from orders where status not in ('PAID','CANCELLED','VOIDED') order by created_at desc limit 1")[0];
      console.log("  open order:", JSON.stringify(open));
      if (!open) throw new Error("no open order after send-to-kitchen");
    });

    await step("dine-in-addition", "the table orders one more drink: only the addition is sent", async () => {
      const k0 = jobs("prints");
      await reg.addItem(MENU.items[2][0]);
      await reg.click(/^إرسال الإضافة للمطبخ$/);
      await b.pause(3000);
      const fresh = jobs("prints").filter((f) => !k0.includes(f));
      if (fresh.length < 1) throw new Error("addition not sent to kitchen");
      console.log(`  addition ticket ${fresh[0]} (${fs.statSync(path.join(ROOT, ".e2e-pos", "prints", fresh[0])).size} bytes)`);
    });

    await step("void-sent", "voiding a sent item needs the manager PIN; a wrong PIN is refused", async () => {
      const voids = await b.$$('button[aria-label="إلغاء الصنف"]');
      await voids[0].click();
      await b.pause(800);
      await reg.select("خطأ في الطلب");
      await reg.click(/^تأكيد الإلغاء$/);
      await b.pause(800);
      await reg.type("input[type=password]", "111111", 0);
      await reg.click(/^تأكيد الإلغاء$/);
      await b.pause(1500);
      if (!/رمز المدير غير صحيح/.test(await reg.text())) throw new Error("wrong manager PIN was not refused");
      await reg.type("input[type=password]", OWNER.pin, 0);
      await reg.click(/^تأكيد الإلغاء$/);
      await b.pause(1500);
      const [row] = lsql("select count(*) n from order_items where voided = 1");
      console.log("  voided items in DB:", row.n);
      if (row.n < 1) throw new Error("void not recorded in the database");
    });

    await step("dine-in-pay", "the table pays by cash; the table becomes free", async () => {
      const r0 = jobs("receipts").length;
      // A void cancels the whole line (both item0), leaving item1 + item2.
      const due = MENU.items[1][1] + MENU.items[2][1];
      await reg.waitText(money(due));
      await pay(due);
      if (jobs("receipts").length - r0 < 1) throw new Error("no receipt for the table");
      const [row] = lsql("select count(*) n from tables where status = 'OCCUPIED'");
      if (row.n) throw new Error(`${row.n} table(s) still occupied after paying`);
    });

    await step("kds", "the kitchen screen shows orders and moves one to preparing", async () => {
      await reg.click(/^المطبخ$/);
      await reg.waitText("شاشة المطبخ");
      await b.pause(1500);
      await reg.click(/^بدء التحضير$/);
      await b.pause(1500);
      const t = await reg.text();
      console.log("  KDS:", (t.match(/(انتظار|تحضير|جاهز): \d+/g) ?? []).join(" "));
      await reg.shot("kds");
      if (!/تحضير: [1-9]/.test(t)) throw new Error("order did not move to preparing");
    });
  }

  const DEBTOR = { name: "أبو خالد", phone: "0944123456" };
  await step("debt-sale", "a regular takes goods on credit (دين); the debtor is created at the till", async () => {
    await reg.click(/^نقاط البيع$/);
    await b.pause(1000);
    await reg.click(/^دين$/);
    await reg.click(/^اختيار مدين$/);
    await b.pause(600);
    await reg.click(/^مدين جديد$/);
    await reg.type('input[placeholder="الاسم *"]', DEBTOR.name, 0);
    await reg.type('input[placeholder="رقم الهاتف"]', DEBTOR.phone, 0);
    await reg.click(/^حفظ$/);
    await b.pause(1200);
    await reg.addItem(MENU.items[0][0]);
    await reg.click(/^دفع$/);
    await b.pause(1000);
    await reg.shot("debt-payment");
    console.log("  DEBT PAY:", (await reg.text()).slice(-350).replace(/\n+/g, " | "));
    await reg.click(/تأكيد/);
    await b.pause(2500);
    const d = lsql(`select balance_cents from debtors where name = '${DEBTOR.name}'`)[0];
    console.log("  debtor balance:", d?.balance_cents);
    if (!d) throw new Error("debtor not created");
    if (d.balance_cents !== MENU.items[0][1]) throw new Error(`debtor owes ${d.balance_cents}, expected ${MENU.items[0][1]}`);
  });

  await step("debt-repay", "the debtor pays back 5,000", async () => {
    await reg.click(/^الديون$/);
    await reg.waitText(DEBTOR.name);
    await reg.shot("debts");
    console.log("  DEBTS:", (await reg.text()).slice(-300).replace(/\n+/g, " | "));
    const controls = await b.execute(() => [...document.querySelectorAll("button")].filter((e) => e.offsetParent).map((e) => (e.innerText || e.title || e.getAttribute("aria-label") || "").trim()));
    console.log("  controls:", controls.slice(-8).join(" || "));
    await reg.click(/^تسديد$/);
    await b.pause(800);
    console.log("  REPAY FORM:", (await reg.text()).slice(-300).replace(/\n+/g, " | "));
    await reg.type('input[placeholder="المبلغ"]', "5000", 0);
    // The dialog's submit (text) -- not the row's icon button (title only).
    await b.execute(() => [...document.querySelectorAll("button")].find((e) => e.innerText.trim() === "تسديد" && e.offsetParent)?.click());
    await b.pause(1500);
    await reg.shot("debt-repaid");
    const t = await reg.text();
    if (!t.includes(money(MENU.items[0][1] - 5000))) throw new Error(`remaining ${money(MENU.items[0][1] - 5000)} not shown after repayment`);
  });

  await step("refund", "the owner refunds the last paid order from reports", async () => {
    await reg.click(/^التقارير$/);
    await b.pause(2000);
    await reg.click(/^استرداد$/);
    // confirm() then prompt() for the (optional) reason.
    for (let i = 0; i < 3; i++) {
      try { console.log("  dialog:", (await reg.acceptDialog({ timeout: 3000 })).slice(0, 60)); } catch { break; }
    }
    await b.pause(2000);
    await reg.shot("refund");
    const [row] = lsql("select count(*) n from orders where refunded_cents > 0");
    if (!row.n) throw new Error("refund not recorded");
  });

  await step("close-shift", "closing the shift: counting exactly the expected cash gives zero difference", async () => {
    await reg.click(/^الوردية$/);
    await b.pause(1500);
    const [shift] = lsql("select id, starting_cash_cents from shifts where closed_at is null");
    const [cash] = lsql(`select coalesce(sum(p.amount_cents - coalesce(p.change_cents, 0)), 0) kept from payments p join orders o on o.id = p.order_id where p.method = 'CASH' and o.status = 'PAID' and o.shift_id = '${shift.id}'`);
    const expected = shift.starting_cash_cents + cash.kept;
    console.log(`  opening ${money(shift.starting_cash_cents)} + cash kept ${money(cash.kept)} = ${money(expected)}`);
    await reg.click(/^إغلاق الوردية$/);
    await b.pause(800);
    await reg.type('input[placeholder="0.00"]', String(expected), 0);
    await b.pause(500);
    await reg.click(/^تأكيد الإغلاق$/);
    await b.pause(2500);
    await reg.shot("shift-closed");
    const t = await reg.text();
    console.log("  CLOSE:", t.slice(t.indexOf("ملخص"), t.indexOf("ملخص") + 400).replace(/\n+/g, " | "));
    const [closed] = lsql(`select * from shifts where id = '${shift.id}'`);
    console.log("  shift row:", JSON.stringify(closed));
    if (!closed.closed_at) throw new Error("shift not closed");
    if (closed.difference_cents !== 0) throw new Error(`difference ${closed.difference_cents} (expected 0 for an exact count)`);
  });

  await step("reports", "today's report matches the database", async () => {
    await reg.click(/^التقارير$/);
    await b.pause(2500);
    const [db] = lsql("select count(*) n, coalesce(sum(total_cents), 0) total from orders where status = 'PAID' and date(created_at) = date('now')");
    const t = await reg.text();
    const at = t.indexOf("إجمالي المبيعات");
    console.log(`  DB: ${db.n} paid orders, ${money(db.total)}; screen: ${t.slice(at, at + 120).replace(/\n+/g, " ")}`);
    if (!t.includes(money(db.total))) throw new Error("report total differs from the database");
  });

  await step("cloud-sync", "orders reach the cloud (sync-pos) within two minutes", async () => {
    const [local] = lsql("select count(*) n from orders where status = 'PAID'");
    let cloud = 0;
    for (let i = 0; i < 24; i++) {
      cloud = Number(await sql(`select count(*) from pos_order where tenant_id = '${TENANT_ID}' and status = 'PAID' and synced_at > now() - interval '1 hour'`));
      if (cloud >= local.n) break;
      await b.pause(5000);
    }
    console.log(`  local paid ${local.n}, cloud paid ${cloud}`);
    if (cloud < local.n) throw new Error("not all paid orders reached the cloud");
  });
}
