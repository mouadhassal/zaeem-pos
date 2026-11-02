// The numbers behind the dashboard / finance / reports profit cards. They all
// come from the till's one profit module (src-tauri/src/profit.rs), so every
// screen shows the same figures. Pure helpers only: no invoke, no DOM.

export { tzOffsetMinutes } from "./assistant";

/** One day (or one whole period) of sales and profit. Mirrors profit.rs `DayProfit`. */
export interface DayProfit {
  date?: string;
  order_count: number;
  gross_sales_cents: number;
  refunds_cents: number;
  net_sales_cents: number;
  cogs_cents: number;
  margin_profit_cents: number;
  expenses_cents: number;
  food_purchases_cents: number;
  operating_expenses_cents: number;
  salaries_cents: number;
  expense_profit_cents: number;
  net_profit_cents: number;
}

/** A whole period. Mirrors profit.rs `ProfitSummary` (the day fields are flattened in). */
export interface ProfitSummary extends DayProfit {
  /** Margin profit as a share of net sales, in basis points (5000 = 50%). */
  margin_bp: number;
  /** Different items sold with no cost price entered. */
  items_without_cost: number;
}

/** 6000 -> "60%", 3333 -> "33.3%". */
export function formatMarginPercent(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** Expense categories the owner picks from. The first one is buying food; it is not counted twice in the net profit. */
export const EXPENSE_CATEGORIES = ["مشتريات مواد", "إيجار", "رواتب", "كهرباء", "مياه", "إنترنت", "صيانة", "مستلزمات", "تسويق", "أخرى"] as const;

/** What a category means for the profit lines, shown under the category picker. */
export function categoryHint(category: string): string {
  if (category === "مشتريات مواد" || category === "مشتريات من الموردين") {
    return "شراء مواد للبيع (دجاج، زيت، سكر…). تدخل في «الربح بالمصروفات» فقط، ولا تُحسب مرتين في «صافي الربح الفعلي» لأن تكلفة ما بعته محسوبة في الهامش.";
  }
  if (category === "رواتب") {
    return "تدخل في «الربح بالمصروفات» وفي «صافي الربح الفعلي». الأفضل أن تُسجَّل من «الرواتب» تلقائياً عند صرف الراتب.";
  }
  return "مصروف جارٍ: يدخل في «الربح بالمصروفات» وفي «صافي الربح الفعلي».";
}

export const PROFIT_EXPLAINER_INTRO = "كل أنواع الربح تبدأ من «صافي المبيعات»: ما بعته ناقص ما أرجعته للزبائن.";

export interface ProfitExplainerItem {
  title: string;
  formula: string;
  text: string;
}

export const PROFIT_EXPLAINER: ProfitExplainerItem[] = [
  {
    title: "ربح الهامش",
    formula: "صافي المبيعات − تكلفة الأصناف المباعة",
    text: "مثال: ساندويش كلفته 10 ويُباع بـ 20، ربحه 10 وهامشه 50%. يقيس ربح ما بعته فعلاً مهما كان وقت شراء المواد. يحتاج أن تُدخل «التكلفة» لكل صنف في القائمة.",
  },
  {
    title: "الربح بالمصروفات",
    formula: "صافي المبيعات − كل المصروفات المسجلة",
    text: "يعتمد على ما سجّلته في المالية ← التكاليف (دجاج، زيت، سكر، إيجار، رواتب…). يتأثر بيوم الشراء: يوم تشتري فيه مخزوناً كبيراً يبدو الربح منخفضاً.",
  },
  {
    title: "صافي الربح الفعلي",
    formula: "ربح الهامش − المصروفات الجارية (إيجار، رواتب، فواتير)",
    text: "لا تُحسب فيه مشتريات المواد لأن تكلفتها داخل الهامش أصلاً، فلا يُعدّ الدجاج مرتين. هو الأقرب لما يبقى لك فعلاً.",
  },
];

export const REFUND_NOTE = "المرتجع ينقص المبيعات في يوم الإرجاع. أما تكلفة الطبق المُرجع فتبقى محسوبة لأنه صُنع.";
