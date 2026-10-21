import { describe, expect, it } from "vitest";
import {
  kitchenTicketRows,
  receiptLineCents,
  receiptRows,
  rowsText,
  type KitchenTicketData,
  type ReceiptData,
} from "./ticketLayout";

const NOW = new Date("2026-10-20T14:30:00");
const EARLIER = new Date("2026-10-20T14:05:00").toISOString();

const ticket = (over: Partial<KitchenTicketData> = {}): KitchenTicketData => ({
  tableName: "5",
  orderNumber: "A17",
  orderType: "DINE_IN",
  items: [
    { name: "شاورما دجاج", quantity: 2, modifiers: ["بدون بصل", "زيادة جبنة"], notes: "حار" },
    { name: "كولا", quantity: 1 },
  ],
  ...over,
});

const text = (t: KitchenTicketData) => rowsText(kitchenTicketRows(t, NOW)).join("\n");

describe("kitchen ticket", () => {
  it("shows every option and note the cashier set, on the line they belong to", () => {
    const t = text(ticket());
    expect(t).toContain("2 × شاورما دجاج");
    expect(t).toContain("◂ بدون بصل");
    expect(t).toContain("◂ زيادة جبنة");
    expect(t).toContain("ملاحظة: حار");
    expect(t.indexOf("بدون بصل")).toBeGreaterThan(t.indexOf("شاورما"));
    expect(t.indexOf("كولا")).toBeGreaterThan(t.indexOf("بدون بصل"));
  });

  it("makes a 'without' line bold so a cook cannot miss it", () => {
    const rows = kitchenTicketRows(ticket(), NOW);
    const without = rows.find((r) => r.t === "line" && r.text.includes("بدون بصل"));
    const extra = rows.find((r) => r.t === "line" && r.text.includes("زيادة جبنة"));
    expect(without && without.t === "line" && without.bold).toBe(true);
    expect(extra && extra.t === "line" && extra.bold).toBe(false);
  });

  it("carries order number, type, table, cashier and both times", () => {
    const t = text(ticket({ cashier: "ليلى", createdAt: EARLIER }));
    expect(t).toContain("رقم الطلب | A17");
    expect(t).toContain("النوع | صالة");
    expect(t).toContain("طاولة | 5");
    expect(t).toContain("الكاشير | ليلى");
    expect(t).toContain("وقت الطلب");
    expect(t).toContain("وقت الطباعة");
  });

  it("order time is when the order was taken, not when the slip was printed", () => {
    const rows = kitchenTicketRows(ticket({ createdAt: EARLIER }), NOW);
    const taken = rows.find((r) => r.t === "two" && r.right === "وقت الطلب");
    const printed = rows.find((r) => r.t === "two" && r.right === "وقت الطباعة");
    expect(taken && taken.t === "two" && printed && printed.t === "two" && taken.left !== printed.left).toBe(true);
  });

  it("does not print a table row for the counter or for no table", () => {
    expect(text(ticket({ tableName: "المنضدة" }))).not.toContain("طاولة");
    expect(text(ticket({ tableName: "" }))).not.toContain("طاولة");
  });

  it("titles each kind of slip differently", () => {
    expect(text(ticket())).toContain("*** المطبخ ***");
    expect(text(ticket({ kind: "ADDITION" }))).toContain("*** إضافة للطلب ***");
    expect(text(ticket({ kind: "CANCEL", cancelReason: "العميل غير راغب" }))).toContain("*** إلغاء ***");
    expect(text(ticket({ kind: "EDIT", replaces: [{ name: "شاورما دجاج", quantity: 1 }] }))).toContain("*** تعديل ***");
  });

  it("a cancellation says what to stop and why", () => {
    const t = text(ticket({ kind: "CANCEL", cancelReason: "العميل غير راغب" }));
    expect(t).toContain("ألغِ هذه الأصناف");
    expect(t).toContain("السبب: العميل غير راغب");
    expect(t).toContain("✗ 2 × شاورما دجاج");
  });

  it("an edit shows the old line and the new line", () => {
    const t = text(ticket({
      kind: "EDIT",
      items: [{ name: "شاورما دجاج", quantity: 1, modifiers: ["بدون ثوم"] }],
      replaces: [{ name: "شاورما دجاج", quantity: 1, modifiers: ["بدون بصل"] }],
    }));
    const before = t.indexOf("قبل التعديل");
    const after = t.indexOf("بعد التعديل");
    expect(before).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(before);
    expect(t.indexOf("بدون بصل")).toBeGreaterThan(before);
    expect(t.indexOf("بدون بصل")).toBeLessThan(after);
    expect(t.indexOf("بدون ثوم")).toBeGreaterThan(after);
  });

  it("a station slip says which station it is and where the rest of the order went", () => {
    const t = text(ticket({
      station: "البيتزا", stationNo: 1, stationOf: 2,
      alsoSentTo: [{ name: "الشواء", count: 3 }],
    }));
    expect(t).toContain("البيتزا");
    expect(t).toContain("قسم 1 من 2");
    expect(t).toContain("يُرسل الباقي إلى");
    expect(t).toContain("الشواء (3)");
  });

  it("a single-station order has no split lines", () => {
    const t = text(ticket({ station: "البيتزا", stationNo: 1, stationOf: 1 }));
    expect(t).not.toContain("قسم");
    expect(t).not.toContain("يُرسل الباقي");
  });

  it("marks a reprint as a copy", () => {
    expect(text(ticket({ isCopy: true }))).toContain("(نسخة مكررة)");
    expect(text(ticket())).not.toContain("نسخة");
  });

  it("names the customer on a takeaway or delivery order", () => {
    expect(text(ticket({ orderType: "DELIVERY", customerName: "أحمد", tableName: "" }))).toContain("العميل | أحمد");
    expect(text(ticket({ orderType: "DELIVERY", tableName: "" }))).toContain("النوع | توصيل");
  });
});

const receipt = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  chainName: "مطعم الشام", branchName: "الفرع الرئيسي", orderNumber: "A17", tableName: "5", orderType: "DINE_IN",
  items: [
    { name: "شاورما دجاج", quantity: 2, priceCents: 10_000, modifiers: [{ name: "بدون بصل", priceCents: 0 }, { name: "زيادة جبنة", priceCents: 2_000 }], notes: "حار" },
    { name: "كولا", quantity: 1, priceCents: 3_000, comped: true, compReason: "تعويض عن خطأ" },
  ],
  subtotalCents: 24_000, taxCents: 0, secondaryTaxCents: 0, serviceChargeCents: 0, discountCents: 0, savingsCents: 0,
  totalCents: 24_000, paymentMethod: "CASH", changeCents: 1_000, ...over,
});
const rtext = (r: ReceiptData) => rowsText(receiptRows(r, NOW)).join("\n");

describe("receipt", () => {
  it("prints the branch name once when the shop has no name of its own", () => {
    const lines = rowsText(receiptRows(receipt({ chainName: "الفرع الرئيسي" }), NOW));
    expect(lines.filter((l) => l === "الفرع الرئيسي")).toHaveLength(1);
    expect(rowsText(receiptRows(receipt(), NOW))).toContain("الفرع الرئيسي");
  });
  it("charges options and not gifts, and the lines add up to the subtotal", () => {
    const r = receipt();
    expect(receiptLineCents(r.items[0]!)).toBe(24_000); // 2 x (10,000 + 2,000)
    expect(receiptLineCents(r.items[1]!)).toBe(0);
    const sum = r.items.reduce((s, i) => s + receiptLineCents(i), 0);
    expect(sum).toBe(r.subtotalCents);
  });

  it("shows options, their price, and the kitchen note under each line", () => {
    const t = rtext(receipt());
    expect(t).toContain("2 × شاورما دجاج");
    expect(t).toContain("◂ بدون بصل");
    expect(t).toContain("◂ زيادة جبنة");
    expect(t).toContain("ملاحظة: حار");
  });

  it("lists a gift as a gift with its reason and value, outside the total", () => {
    const t = rtext(receipt());
    expect(t).toContain("1 × كولا | ضيافة");
    expect(t).toContain("تعويض عن خطأ");
    expect(t).toContain("قيمة الضيافة (غير محتسبة)");
  });

  it("is traceable: order number, cashier, when it was taken and when it was paid", () => {
    const t = rtext(receipt({ cashier: "ليلى", createdAt: EARLIER }));
    expect(t).toContain("رقم الطلب | A17");
    expect(t).toContain("الكاشير | ليلى");
    expect(t).toContain("وقت الطلب");
    expect(t).toContain("وقت الدفع");
  });

  it("states the payment method", () => {
    expect(rtext(receipt({ paymentMethod: "CARD" }))).toContain("طريقة الدفع | بطاقة");
    expect(rtext(receipt({ paymentMethod: "CASH" }))).toContain("طريقة الدفع | نقداً");
  });

  it("lists cancelled lines as not charged", () => {
    const t = rtext(receipt({ cancelledItems: [{ name: "بطاطا", quantity: 1, reason: "تأخير" }] }));
    expect(t).toContain("أصناف ملغاة (غير محتسبة)");
    expect(t).toContain("✗ 1 × بطاطا — تأخير");
    expect(rtext(receipt())).not.toContain("أصناف ملغاة");
  });

  it("prints delivery details and the delivery fee", () => {
    const t = rtext(receipt({
      orderType: "DELIVERY", tableName: "", customerName: "أحمد", customerPhone: "0933000000",
      deliveryAddress: "المزة - شارع الجلاء", deliveryFeeCents: 5_000,
    }));
    expect(t).toContain("النوع | توصيل");
    expect(t).toContain("العميل | أحمد");
    expect(t).toContain("الهاتف | 0933000000");
    expect(t).toContain("العنوان | المزة - شارع الجلاء");
    expect(t).toContain("رسوم التوصيل");
  });

  it("a plain sale has none of the extra sections", () => {
    const t = rtext(receipt({
      items: [{ name: "كولا", quantity: 1, priceCents: 3_000 }], subtotalCents: 3_000, totalCents: 3_000, changeCents: 0,
    }));
    expect(t).not.toContain("ضيافة");
    expect(t).not.toContain("ملاحظة");
    expect(t).not.toContain("الكاشير");
    expect(t).not.toContain("رسوم التوصيل");
  });
});

import { deliverySlipRows, driverStatementRows, type StatementLine, type StatementTotals } from "./ticketLayout";

describe("delivery slip", () => {
  const slip = (over = {}) => ({
    chainName: "مطعم الشام", branchName: "الرئيسي", orderNumber: "D9", customerName: "أحمد", customerPhone: "0933000000",
    address: "المزة - شارع الجلاء - بناء 4", items: [{ name: "شاورما", quantity: 2, modifiers: ["بدون بصل"], notes: "حار" }],
    totalCents: 25_000, feeCents: 5_000, paid: false, driverName: "علي", ...over,
  });
  const txt = (s: ReturnType<typeof slip>) => rowsText(deliverySlipRows(s, NOW)).join("\n");

  it("gives the driver everything he needs at the door", () => {
    const t = txt(slip());
    expect(t).toContain("*** توصيل ***");
    expect(t).toContain("رقم الطلب | D9");
    expect(t).toContain("السائق | علي");
    expect(t).toContain("العميل | أحمد");
    expect(t).toContain("الهاتف | 0933000000");
    expect(t).toContain("المزة - شارع الجلاء - بناء 4");
    expect(t).toContain("2 × شاورما");
    expect(t).toContain("◂ بدون بصل");
  });

  it("tells him how much to collect, or that nothing is due", () => {
    expect(txt(slip())).toContain("المطلوب تحصيله");
    const paid = txt(slip({ paid: true }));
    expect(paid).toContain("مدفوع مسبقاً - لا تحصيل");
    expect(paid).not.toContain("المطلوب تحصيله");
  });
});

describe("driver statement slip", () => {
  const line = (over: Partial<StatementLine> = {}): StatementLine => ({
    order_id: "o1", created_at: "2026-10-20T12:10:00Z", status: "DELIVERED", address: "المزة", total_cents: 20_000, fee_cents: 2_000,
    pay_cents: 5_000, cash_due_cents: 20_000, pay_settled: false, cash_settled: false, ...over,
  });
  const totals: StatementTotals = { deliveries: 3, delivered: 2, failed: 1, orders_total_cents: 40_000, fees_cents: 4_000, pay_cents: 10_000, pay_unsettled_cents: 5_000, cash_unsettled_cents: 20_000 };
  const text = rowsText(driverStatementRows("مطعم الشام", "علي", { from: "2026-10-20", to: "2026-10-20" }, [
    line(), line({ order_id: "o2", pay_settled: true, cash_settled: true }), line({ order_id: "o3", status: "FAILED", pay_cents: 0, cash_due_cents: 0 }),
  ], totals, (id) => id.toUpperCase(), NOW)).join("\n");

  it("lists each delivery with its status, address and pay", () => {
    expect(text).toContain("كشف حساب سائق");
    expect(text).toContain("السائق | علي");
    expect(text).toContain("#O1");
    expect(text).toContain("تم التسليم");
    expect(text).toContain("فشل");
    expect(text).toContain("المزة");
  });

  it("shows what he earned, what is still owed, the cash he carries and the net", () => {
    expect(text).toContain("عدد التوصيلات المسلَّمة | 2");
    expect(text).toContain("فاشلة | 1");
    expect(text).toContain("المستحق له");
    expect(text).toContain("النقد الذي معه");
    expect(text).toContain("الصافي (نقد - أجرة)");
  });

  it("marks settled lines and leaves room for a signature", () => {
    expect(text).toContain("✓");
    expect(text).toContain("توقيع السائق");
  });
});
