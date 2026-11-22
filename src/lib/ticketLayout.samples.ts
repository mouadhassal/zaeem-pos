// Fixed sample bills and kitchen slips. ticketLayoutTemplate.test.ts prints them with the standard
// layout and compares the rows with ticketLayout.golden.json, which was written from the layout as
// it was BEFORE receipt templates existed: a printer with no template must still print exactly that.

import type { KitchenTicketData, ReceiptData } from "./ticketLayout";

export const SAMPLE_NOW = new Date("2026-10-20T14:30:00");
const EARLIER = new Date("2026-10-20T14:05:00").toISOString();

const baseReceipt: ReceiptData = {
  chainName: "مطعم الياسمين",
  branchName: "فرع المزة",
  orderNumber: "B-0012",
  tableName: "5",
  orderType: "DINE_IN",
  items: [
    { name: "شاورما دجاج", quantity: 2, priceCents: 1500, modifiers: [{ name: "جبنة", priceCents: 200 }, { name: "بدون بصل", priceCents: 0 }], notes: "حار" },
    { name: "كولا", quantity: 1, priceCents: 300 },
    { name: "تحلية", quantity: 1, priceCents: 800, comped: true, compReason: "ضيافة المدير", notes: "بدون سكر" },
  ],
  subtotalCents: 3700, taxCents: 370, secondaryTaxCents: 50, serviceChargeCents: 100, discountCents: 200, savingsCents: 150,
  totalCents: 4020, paymentMethod: "CASH", changeCents: 980, currency: "SYP", cashier: "ليلى", createdAt: EARLIER, referenceCode: "R-77",
};

const { cashier: _cashier, createdAt: _createdAt, referenceCode: _referenceCode, ...plainSale } = baseReceipt;

export const SAMPLE_RECEIPTS: ReceiptData[] = [
  baseReceipt,
  { ...baseReceipt, orderType: "DELIVERY", tableName: "", orderNumber: "C-0003", customerName: "علي", customerPhone: "0999", deliveryAddress: "المزة - شارع 3", deliveryFeeCents: 500, driverName: "أحمد", isCopy: true, refundedCents: 300, cancelledItems: [{ name: "عصير", quantity: 1, reason: "خطأ" }], paidAt: EARLIER },
  { ...plainSale, branchName: "مطعم الياسمين", tableName: "المنضدة", orderType: "TAKEAWAY", secondaryTaxCents: 0, serviceChargeCents: 0, discountCents: 0, savingsCents: 0, taxCents: 0 },
];

export const SAMPLE_TICKETS: KitchenTicketData[] = [
  { tableName: "5", orderNumber: "B-0012", orderType: "DINE_IN", cashier: "ليلى", createdAt: EARLIER, customerName: "سامر", items: [{ name: "شاورما دجاج", quantity: 2, modifiers: ["بدون بصل", "زيادة جبنة"], notes: "حار" }, { name: "كولا", quantity: 1 }] },
  { tableName: "", orderNumber: "A-0004", orderType: "TAKEAWAY", kind: "CANCEL", cancelReason: "الزبون غيّر رأيه", items: [{ name: "كولا", quantity: 1, notes: "مثلج" }] },
  { tableName: "7", orderNumber: "B-0020", orderType: "DINE_IN", kind: "EDIT", station: "الشواء", stationNo: 1, stationOf: 2, alsoSentTo: [{ name: "البار", count: 2 }], replaces: [{ name: "شاورما", quantity: 1, notes: "عادي" }], items: [{ name: "شاورما", quantity: 2, notes: "حار" }], scheduledAt: "2026-10-20T16:00:00", pickupAt: "2026-10-20T16:15:00", isCopy: true },
];
