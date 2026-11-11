/**
 * What the long printed sales report contains. Every block is a switch the
 * owner picks (Settings > التفضيلات والتصميم, or the print dialog on the
 * Reports page), kept on this device like the other preferences.
 *
 * The default is the report the shops already got before this was
 * customisable, except that the items are now listed under their category.
 */

export interface ReportOptions {
  /** Who printed it and when. */
  showPrintedBy: boolean;
  /** Order count, gross sales, refunds, net sales. */
  showTotals: boolean;
  /** "Of which": discounts, taxes, delivery fees. */
  showBreakdown: boolean;
  /** Cash, card... how the money came in. */
  showPayments: boolean;
  /** Dine-in, takeaway, delivery: count and money. */
  showOrderTypes: boolean;
  /** Every item sold with its quantity, under its category. */
  showItems: boolean;
  /** Next to each item: the money, not only the quantity. */
  showItemAmounts: boolean;
  /** Under each category: its total quantity and money. */
  showCategoryTotals: boolean;
  /** One short list at the end: each category with its total. */
  showCategorySummary: boolean;
  /** Gifts, cancelled lines and orders (not counted in the sales). */
  showNotCounted: boolean;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  showPrintedBy: true,
  showTotals: true,
  showBreakdown: true,
  showPayments: true,
  showOrderTypes: true,
  showItems: true,
  showItemAmounts: true,
  showCategoryTotals: true,
  showCategorySummary: false,
  showNotCounted: true,
};

export const REPORT_OPTION_LABELS: { key: keyof ReportOptions; label: string; hint?: string }[] = [
  { key: "showTotals", label: "المجاميع", hint: "عدد الطلبات، إجمالي المبيعات، المرتجعات، الصافي" },
  { key: "showBreakdown", label: "الخصومات والضرائب ورسوم التوصيل", hint: "تظهر تحت الصافي كتفصيل" },
  { key: "showPayments", label: "طرق الدفع", hint: "نقداً، بطاقة... كم دخل من كل طريقة" },
  { key: "showOrderTypes", label: "أنواع الطلبات", hint: "صالة، سفري، توصيل: العدد والمبلغ" },
  { key: "showItems", label: "الأصناف المباعة حسب الفئة", hint: "كل صنف بكميته تحت فئته (ساندويشات، مشروبات...)" },
  { key: "showItemAmounts", label: "مبلغ كل صنف", hint: "إيقافه يطبع الكميات فقط" },
  { key: "showCategoryTotals", label: "مجموع كل فئة", hint: "تحت كل فئة: كم قطعة وكم مبلغ" },
  { key: "showCategorySummary", label: "ملخص الفئات في النهاية", hint: "قائمة قصيرة بالفئات ومجموعها" },
  { key: "showNotCounted", label: "الضيافة والملغي", hint: "غير محتسب في المبيعات" },
  { key: "showPrintedBy", label: "اسم من طبع الورقة" },
];

/** Reads whatever was stored (old, partial, hand-edited) into valid options. */
export function normalizeReportOptions(raw: unknown): ReportOptions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_REPORT_OPTIONS };
  for (const k of Object.keys(DEFAULT_REPORT_OPTIONS) as (keyof ReportOptions)[]) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  return out;
}
