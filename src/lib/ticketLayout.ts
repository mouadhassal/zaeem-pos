// What goes on a kitchen ticket and on the customer receipt, as plain rows.
// printer.ts draws these rows onto a canvas; keeping the content separate from
// the drawing means every detail (options, notes, times, gifts, who served)
// can be tested without a canvas or a printer.

import { formatMoney } from "./money";
import { formatArabicDate, formatArabicTime } from "./dateLocal";

export type Row =
  | { t: "line"; text: string; size?: number; bold?: boolean; align?: "right" | "left" | "center" }
  | { t: "two"; right: string; left: string; size?: number; bold?: boolean }
  | { t: "rule"; dashed?: boolean }
  | { t: "gap"; h: number };

export interface ReceiptItem {
  name: string;
  quantity: number;
  priceCents: number;
  modifiers?: { name: string; priceCents: number }[];
  /** Free-text note the cashier typed for the kitchen. */
  notes?: string;
  /** "On the house": listed with its value but not charged. */
  comped?: boolean;
  compReason?: string;
  comboId?: string;
}

export interface ReceiptData {
  chainName: string;
  branchName: string;
  orderNumber: string;
  tableName: string;
  orderType: string;
  items: ReceiptItem[];
  subtotalCents: number;
  taxCents: number;
  secondaryTaxCents: number;
  serviceChargeCents: number;
  discountCents: number;
  savingsCents: number;
  totalCents: number;
  paymentMethod: string;
  changeCents: number;
  currency?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  deliveryFeeCents?: number;
  /** Who served: printed so a disputed receipt can be traced to a person. */
  cashier?: string;
  /** When the order was taken (ISO). Falls back to "now" for a new sale. */
  createdAt?: string;
  /** Lines taken off the order before it was paid, with why. */
  cancelledItems?: { name: string; quantity: number; reason?: string }[];
  /**
   * 2026-09-13 audit fix: the cashier-entered terminal/wallet approval code
   * for CARD/WALLET payments (required in PaymentModal.tsx before
   * "Confirm" is enabled -- see that file's own comment). Shown on the
   * receipt as the one natural, already-payment-time place to surface it;
   * absent for CASH/CREDIT, which never collect one.
   */
  referenceCode?: string;
}

export type TicketKind = "NEW" | "ADDITION" | "CANCEL" | "EDIT";

export interface TicketItem {
  name: string;
  quantity: number;
  notes?: string;
  modifiers?: string[];
  menuItemId?: string;
}

export interface KitchenTicketData {
  tableName: string;
  orderNumber: string;
  orderType: string;
  items: TicketItem[];
  scheduledAt?: string;
  /** Station name printed under the title when this copy is for one kitchen station only. */
  station?: string;
  /** NEW (default), ADDITION to an order already in the kitchen, CANCEL of lines, or EDIT of a line. */
  kind?: TicketKind;
  cashier?: string;
  /** When the order was taken (ISO). Falls back to "now". */
  createdAt?: string;
  customerName?: string;
  /** For CANCEL: why the lines were taken off. */
  cancelReason?: string;
  /** For EDIT: the lines as they were before; `items` holds them as they are now. */
  replaces?: TicketItem[];
  /** Other stations that got a share of this same order, so nobody wonders where the rest went. */
  alsoSentTo?: { name: string; count: number }[];
  stationNo?: number;
  stationOf?: number;
  /** A reprint of a ticket that was already printed once. */
  isCopy?: boolean;
}

const ORDER_TYPE_LABELS: Record<string, string> = {
  DINE_IN: "داخلي",
  TAKEAWAY: "سفري",
  DELIVERY: "توصيل",
  ONLINE: "أونلاين",
};

const PAYMENT_LABELS: Record<string, string> = {
  CASH: "نقداً",
  CARD: "بطاقة",
  WALLET: "محفظة",
  CREDIT: "دين",
};

const TITLES: Record<TicketKind, string> = {
  NEW: "*** المطبخ ***",
  ADDITION: "*** إضافة للطلب ***",
  CANCEL: "*** إلغاء ***",
  EDIT: "*** تعديل ***",
};

// The implicit counter table ("المنضدة") carries takeaway and every sale in
// a shop with no tables -- printing "طاولة: المنضدة" on those receipts
// and kitchen tickets read as if the customer sat at a table.
export function isSeatedTable(name: string | undefined): name is string {
  return !!name && name !== "المنضدة";
}

const dateTime = (d: Date) => `${formatArabicDate(d)} ${formatArabicTime(d)}`;
const parse = (iso: string | undefined, fallback: Date) => {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d;
};

function itemRows(items: readonly TicketItem[], prefix = ""): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    rows.push({ t: "line", text: `${prefix}${item.quantity} × ${item.name}`, bold: true, size: 28 });
    for (const mod of item.modifiers ?? []) {
      // "Without ..." is the part a cook must not miss.
      rows.push({ t: "line", text: `  ◂ ${mod}`, size: 24, bold: mod.startsWith("بدون") });
    }
    if (item.notes) rows.push({ t: "line", text: `  ملاحظة: ${item.notes}`, size: 24, bold: true });
    rows.push({ t: "gap", h: 6 });
  }
  return rows;
}

export function kitchenTicketRows(data: KitchenTicketData, now: Date = new Date()): Row[] {
  const kind = data.kind ?? "NEW";
  const rows: Row[] = [];
  rows.push({ t: "line", text: TITLES[kind], size: 38, bold: true, align: "center" });
  if (data.isCopy) rows.push({ t: "line", text: "(نسخة مكررة)", size: 24, align: "center" });
  if (data.station) rows.push({ t: "line", text: data.station, size: 34, bold: true, align: "center" });
  if (data.stationOf && data.stationOf > 1 && data.stationNo) {
    rows.push({ t: "line", text: `قسم ${data.stationNo} من ${data.stationOf}`, size: 24, align: "center" });
  }
  rows.push({ t: "gap", h: 6 });
  rows.push({ t: "rule" });

  if (isSeatedTable(data.tableName)) rows.push({ t: "two", right: "طاولة", left: data.tableName });
  rows.push({ t: "two", right: "رقم الطلب", left: data.orderNumber, bold: true });
  rows.push({ t: "two", right: "النوع", left: ORDER_TYPE_LABELS[data.orderType] ?? data.orderType });
  if (data.customerName) rows.push({ t: "two", right: "العميل", left: data.customerName });
  if (data.cashier) rows.push({ t: "two", right: "الكاشير", left: data.cashier });
  rows.push({ t: "two", right: "وقت الطلب", left: dateTime(parse(data.createdAt, now)) });
  rows.push({ t: "two", right: "وقت الطباعة", left: formatArabicTime(now) });
  if (data.scheduledAt) {
    rows.push({ t: "two", right: "مجدول", left: formatArabicTime(new Date(data.scheduledAt)), bold: true });
  }
  rows.push({ t: "rule" });

  if (kind === "CANCEL") {
    rows.push({ t: "line", text: "ألغِ هذه الأصناف:", size: 28, bold: true });
    if (data.cancelReason) rows.push({ t: "line", text: `السبب: ${data.cancelReason}`, size: 24 });
    rows.push(...itemRows(data.items, "✗ "));
  } else if (kind === "EDIT") {
    rows.push({ t: "line", text: "قبل التعديل (ألغِه):", size: 26, bold: true });
    rows.push(...itemRows(data.replaces ?? [], "✗ "));
    rows.push({ t: "rule", dashed: true });
    rows.push({ t: "line", text: "بعد التعديل (حضّره):", size: 26, bold: true });
    rows.push(...itemRows(data.items));
  } else {
    rows.push(...itemRows(data.items));
  }

  rows.push({ t: "rule" });
  if (data.alsoSentTo && data.alsoSentTo.length > 0) {
    rows.push({ t: "line", text: "يُرسل الباقي إلى:", size: 22 });
    for (const s of data.alsoSentTo) rows.push({ t: "line", text: `  ${s.name} (${s.count})`, size: 22 });
  }
  rows.push({ t: "gap", h: 16 });
  return rows;
}

/** What one receipt line is charged: options included, nothing if it is a gift. */
export function receiptLineCents(item: ReceiptItem): number {
  if (item.comped) return 0;
  const options = (item.modifiers ?? []).reduce((s, m) => s + m.priceCents, 0);
  return (item.priceCents + options) * item.quantity;
}

/** What a gift line would have cost. */
export function receiptLineValueCents(item: ReceiptItem): number {
  const options = (item.modifiers ?? []).reduce((s, m) => s + m.priceCents, 0);
  return (item.priceCents + options) * item.quantity;
}

export function receiptRows(data: ReceiptData, now: Date = new Date()): Row[] {
  const fmt = formatMoney;
  const rows: Row[] = [];

  rows.push({ t: "line", text: data.chainName, size: 42, bold: true, align: "center" });
  rows.push({ t: "line", text: data.branchName, size: 24, align: "center" });
  rows.push({ t: "gap", h: 6 });
  rows.push({ t: "rule" });

  rows.push({ t: "two", right: "رقم الطلب", left: data.orderNumber, bold: true });
  rows.push({ t: "two", right: "التاريخ", left: formatArabicDate(now) });
  if (data.createdAt) rows.push({ t: "two", right: "وقت الطلب", left: formatArabicTime(parse(data.createdAt, now)) });
  rows.push({ t: "two", right: data.createdAt ? "وقت الدفع" : "الوقت", left: formatArabicTime(now) });
  if (data.cashier) rows.push({ t: "two", right: "الكاشير", left: data.cashier });
  // 2026-08-13 generalization fix: was drawn unconditionally -- a takeaway/
  // delivery order (tableName = "") or ANY order from a has_tables=false
  // business printed a "طاولة" row with nothing next to it, on every
  // single receipt for a non-table business.
  if (isSeatedTable(data.tableName)) rows.push({ t: "two", right: "طاولة", left: data.tableName });
  rows.push({ t: "two", right: "النوع", left: ORDER_TYPE_LABELS[data.orderType] ?? data.orderType });
  if (data.customerName) rows.push({ t: "two", right: "العميل", left: data.customerName });
  if (data.customerPhone) rows.push({ t: "two", right: "الهاتف", left: data.customerPhone });
  if (data.deliveryAddress) rows.push({ t: "two", right: "العنوان", left: data.deliveryAddress });
  rows.push({ t: "rule" });

  let giftValue = 0;
  for (const item of data.items) {
    if (item.comped) {
      const value = receiptLineValueCents(item);
      giftValue += value;
      rows.push({ t: "two", right: `${item.quantity} × ${item.name}`, left: "ضيافة", bold: true });
      for (const mod of item.modifiers ?? []) rows.push({ t: "line", text: `  ◂ ${mod.name}`, size: 20 });
      if (item.notes) rows.push({ t: "line", text: `  ملاحظة: ${item.notes}`, size: 20 });
      rows.push({ t: "two", right: `  ${item.compReason ?? "ضيافة"}`, left: `القيمة ${fmt(value)}`, size: 20 });
      continue;
    }
    rows.push({ t: "two", right: `${item.quantity} × ${item.name}`, left: fmt(receiptLineCents(item)), bold: true });
    for (const mod of item.modifiers ?? []) {
      rows.push({ t: "two", right: `  ◂ ${mod.name}`, left: mod.priceCents > 0 ? `+${fmt(mod.priceCents * item.quantity)}` : "", size: 20 });
    }
    if (item.notes) rows.push({ t: "line", text: `  ملاحظة: ${item.notes}`, size: 20 });
  }

  if (data.cancelledItems && data.cancelledItems.length > 0) {
    rows.push({ t: "rule", dashed: true });
    rows.push({ t: "line", text: "أصناف ملغاة (غير محتسبة):", size: 20 });
    for (const c of data.cancelledItems) {
      rows.push({ t: "line", text: `  ✗ ${c.quantity} × ${c.name}${c.reason ? ` — ${c.reason}` : ""}`, size: 20 });
    }
  }

  rows.push({ t: "rule" });
  rows.push({ t: "two", right: "المجموع الفرعي", left: fmt(data.subtotalCents) });
  if (data.serviceChargeCents > 0) rows.push({ t: "two", right: "خدمة", left: fmt(data.serviceChargeCents) });
  rows.push({ t: "two", right: "الضريبة", left: fmt(data.taxCents) });
  if (data.secondaryTaxCents > 0) rows.push({ t: "two", right: "ضريبة إضافية", left: fmt(data.secondaryTaxCents) });
  if (data.deliveryFeeCents && data.deliveryFeeCents > 0) rows.push({ t: "two", right: "رسوم التوصيل", left: fmt(data.deliveryFeeCents) });
  if (data.discountCents > 0) rows.push({ t: "two", right: "الخصم", left: `-${fmt(data.discountCents)}` });
  if (giftValue > 0) rows.push({ t: "two", right: "قيمة الضيافة (غير محتسبة)", left: fmt(giftValue), size: 22 });
  if (data.savingsCents > 0) rows.push({ t: "two", right: "وفرتم", left: fmt(data.savingsCents), bold: true });

  rows.push({ t: "rule" });
  rows.push({ t: "two", right: "الإجمالي", left: fmt(data.totalCents), size: 34, bold: true });
  rows.push({ t: "rule" });

  if (data.paymentMethod) rows.push({ t: "two", right: "طريقة الدفع", left: PAYMENT_LABELS[data.paymentMethod] ?? data.paymentMethod });
  if (data.changeCents > 0) rows.push({ t: "two", right: "الباقي", left: fmt(data.changeCents) });
  if (data.referenceCode) rows.push({ t: "two", right: "رقم المرجع", left: data.referenceCode, size: 20 });

  rows.push({ t: "gap", h: 10 });
  rows.push({ t: "line", text: "شكراً لزيارتكم", align: "center", size: 26 });
  rows.push({ t: "line", text: "نتمنى لكم يوماً سعيداً", align: "center", size: 22 });
  rows.push({ t: "gap", h: 24 });
  return rows;
}

/** All the text on a set of rows, for tests and for the on-screen preview. */
export function rowsText(rows: readonly Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.t === "line") out.push(r.text);
    else if (r.t === "two") out.push(r.left ? `${r.right} | ${r.left}` : r.right);
  }
  return out;
}
