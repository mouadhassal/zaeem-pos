// The words of the app, per type of business. A supplier has no "menu" but a price list, a shop sells
// "products", a café names itself "المقهى". Screens ask `useTerms()` (components) or `getTerms()` (plain code)
// instead of writing the restaurant's word. Which type applies: the owner's choice (business_profile), or,
// for an install that never chose, the type worked out from tables/kitchen (businessModules.inferType) so an
// existing install keeps showing what it showed before.
import { useBusinessStore } from "../stores/businessStore";
import { usePrefsStore } from "../stores/prefsStore";
import type { BusinessType } from "./businessModules";
import type { SidebarNavItem } from "./permissions";

export interface Terms {
  /** The type itself: "مطعم", "مقهى", "متجر", "مورّد". */
  typeLabel: string;
  /** The place, with "ال": "المطعم". */
  place: string;
  /** "لمطعمك": for a sentence addressed to the owner. */
  placeFor: string;
  /** The label of the business-name field. */
  placeName: string;
  /** A believable example of that name (the placeholder). */
  placeNameExample: string;

  /** The catalogue: القائمة / المنتجات / قائمة الأسعار. */
  menu: string;
  /** Title of the catalogue page. */
  menuManage: string;
  /** Sidebar label of the AI set-up page. */
  menuSetupAi: string;
  menuEmptyTitle: string;
  menuEmptyHint: string;
  menuFromPhoto: string;
  /** "السعر في القائمة". */
  menuPrice: string;
  /** "اختر المنتجات من القائمة". */
  pickFromMenu: string;
  /** Sentence on the AI set-up drop zone. */
  menuDropPhotos: string;

  /** One catalogue entry: صنف / منتج / مادة. */
  item: string;
  items: string;
  theItem: string;
  theItems: string;
  /** What the owner enters a cost for, and where: "الصنف في القائمة". */
  itemInMenu: string;
  /** A made-up example sentence for the profit explainer. */
  profitExample: string;
  /** Customer as the customers page names it: عميل / عميل تاجر. */
  client: string;
  theClient: string;
  addItem: string;
  noItems: string;
  searchItem: string;
  topItems: string;
  itemMargins: string;
  /** "تكلفة الأصناف المباعة". */
  soldItemsCost: string;

  category: string;
  categories: string;

  table: string;
  tables: string;
  theTables: string;
  tablesCount: string;

  kitchen: string;
  kitchenScreen: string;
  noKitchenOrders: string;
  sendToKitchen: string;

  customer: string;
  customers: string;
  theCustomer: string;
  /** Sidebar label of the customers page. */
  customersNav: string;
  /** Title of the customers page. */
  customersTitle: string;
  /** Search hint of the orders history. */
  orderSearchHint: string;

  order: string;
  orders: string;
  /** "الطلبات" with "ال". */
  theOrders: string;
  /** Sidebar label of the orders history. */
  ordersNav: string;
  bill: string;
  till: string;
  /** Sidebar label of the till page. */
  tillNav: string;
  /** The order type "eat here". */
  dineIn: string;

  /** The last wizard step when the business has no tables: where the products come from. */
  startHint: string;
}

const restaurant: Terms = {
  typeLabel: "مطعم",
  place: "المطعم",
  placeFor: "لمطعمك",
  placeName: "اسم المطعم",
  placeNameExample: "مطعم الشام",

  menu: "القائمة",
  menuManage: "إدارة القائمة",
  menuSetupAi: "إعداد القائمة AI",
  menuEmptyTitle: "القائمة فارغة",
  menuEmptyHint: "أضف أصنافك من صفحة القائمة، أو صوّر قائمتك الورقية ودع الذكاء الاصطناعي يجهّزها.",
  menuFromPhoto: "من صورة القائمة",
  menuPrice: "السعر في القائمة",
  pickFromMenu: "اختر الأصناف من القائمة",
  menuDropPhotos: "اسحب صور القائمة هنا",

  item: "صنف",
  items: "أصناف",
  theItem: "الصنف",
  theItems: "الأصناف",
  itemInMenu: "الصنف في القائمة",
  profitExample: "ساندويش كلفته 10 ويُباع بـ 20",
  client: "عميل",
  theClient: "العميل",
  addItem: "إضافة صنف",
  noItems: "لا توجد أصناف",
  searchItem: "ابحث عن صنف...",
  topItems: "أفضل الأصناف",
  itemMargins: "هامش الأصناف",
  soldItemsCost: "تكلفة الأصناف المباعة",

  category: "تصنيف",
  categories: "التصنيفات",

  table: "طاولة",
  tables: "طاولات",
  theTables: "الطاولات",
  tablesCount: "عدد الطاولات",

  kitchen: "المطبخ",
  kitchenScreen: "شاشة المطبخ",
  noKitchenOrders: "لا توجد طلبات في المطبخ",
  sendToKitchen: "إرسال للمطبخ",

  customer: "زبون",
  customers: "زبائن",
  theCustomer: "الزبون",
  customersNav: "العملاء",
  customersTitle: "قاعدة العملاء",
  orderSearchHint: "رقم الطلب أو اسم الزبون أو الهاتف",

  order: "طلب",
  orders: "طلبات",
  theOrders: "الطلبات",
  ordersNav: "سجل الطلبات",
  bill: "فاتورة",
  till: "نقطة البيع",
  tillNav: "نقاط البيع",
  dineIn: "داخل المطعم",

  startHint: "ابدأ بإضافة قائمتك، أو صوّر قائمتك الورقية ودع الذكاء الاصطناعي يجهّزها.",
};

const cafe: Terms = {
  ...restaurant,
  typeLabel: "مقهى",
  place: "المقهى",
  placeFor: "لمقهاك",
  placeName: "اسم المقهى",
  placeNameExample: "مقهى الشام",
  dineIn: "داخل المقهى",
};

const shop: Terms = {
  typeLabel: "متجر",
  place: "المتجر",
  placeFor: "لمتجرك",
  placeName: "اسم المتجر",
  placeNameExample: "بقالة الشام",

  menu: "المنتجات",
  menuManage: "إدارة المنتجات",
  menuSetupAi: "إعداد المنتجات AI",
  menuEmptyTitle: "لا توجد منتجات بعد",
  menuEmptyHint: "أضف منتجاتك من صفحة المنتجات، أو استوردها من Excel، أو صوّر قائمتك ودع الذكاء الاصطناعي يجهّزها.",
  menuFromPhoto: "من صورة القائمة",
  menuPrice: "سعر البيع",
  pickFromMenu: "اختر المنتجات",
  menuDropPhotos: "اسحب صور المنتجات هنا",

  item: "منتج",
  items: "منتجات",
  theItem: "المنتج",
  theItems: "المنتجات",
  itemInMenu: "المنتج في صفحة المنتجات",
  profitExample: "منتج كلفته 10 ويُباع بـ 20",
  client: "عميل",
  theClient: "العميل",
  addItem: "إضافة منتج",
  noItems: "لا توجد منتجات",
  searchItem: "ابحث عن منتج أو امسح الباركود...",
  topItems: "أفضل المنتجات",
  itemMargins: "هامش المنتجات",
  soldItemsCost: "تكلفة المنتجات المباعة",

  category: "فئة",
  categories: "الفئات",

  table: "طاولة",
  tables: "طاولات",
  theTables: "الطاولات",
  tablesCount: "عدد الطاولات",

  kitchen: "المطبخ",
  kitchenScreen: "شاشة المطبخ",
  noKitchenOrders: "لا توجد طلبات في المطبخ",
  sendToKitchen: "إرسال للمطبخ",

  customer: "زبون",
  customers: "زبائن",
  theCustomer: "الزبون",
  customersNav: "العملاء",
  customersTitle: "قاعدة العملاء",
  orderSearchHint: "رقم الفاتورة أو اسم الزبون أو الهاتف",

  order: "عملية بيع",
  orders: "عمليات بيع",
  theOrders: "عمليات البيع",
  ordersNav: "سجل المبيعات",
  bill: "فاتورة",
  till: "نقطة البيع",
  tillNav: "نقاط البيع",
  dineIn: "في المحل",

  startHint: "ابدأ باستيراد منتجاتك من ملف Excel (من صفحة مخزون المنتجات)، أو أضفها بمسح الباركود.",
};

const supplier: Terms = {
  ...shop,
  typeLabel: "مورّد",
  place: "المنشأة",
  placeFor: "لمنشأتك",
  placeName: "اسم المنشأة",
  placeNameExample: "الشام للتجارة والتوريد",

  menu: "قائمة الأسعار",
  menuManage: "إدارة قائمة الأسعار",
  menuSetupAi: "إعداد قائمة الأسعار AI",
  menuEmptyTitle: "قائمة الأسعار فارغة",
  menuEmptyHint: "أضف موادك وأسعارها من صفحة قائمة الأسعار، أو استوردها من Excel، أو صوّر قائمة أسعارك ودع الذكاء الاصطناعي يجهّزها.",
  menuFromPhoto: "من صورة قائمة الأسعار",
  menuPrice: "السعر في قائمة الأسعار",
  pickFromMenu: "اختر المواد من قائمة الأسعار",
  menuDropPhotos: "اسحب صور قائمة الأسعار هنا",

  item: "مادة",
  items: "مواد",
  theItem: "المادة",
  theItems: "المواد",
  itemInMenu: "المادة في قائمة الأسعار",
  profitExample: "مادة كلفتها 10 وتُباع بـ 20",
  client: "عميل تاجر",
  theClient: "العميل التاجر",
  addItem: "إضافة مادة",
  noItems: "لا توجد مواد",
  searchItem: "ابحث عن مادة أو امسح الباركود...",
  topItems: "أفضل المواد",
  itemMargins: "هامش المواد",
  soldItemsCost: "تكلفة المواد المباعة",

  customer: "عميل تاجر",
  customers: "عملاء تجار",
  theCustomer: "العميل",
  customersNav: "العملاء التجار",
  customersTitle: "قاعدة العملاء التجار",
  orderSearchHint: "رقم الفاتورة أو اسم العميل أو الهاتف",

  order: "فاتورة بيع",
  orders: "فواتير بيع",
  theOrders: "فواتير البيع",
  ordersNav: "سجل الفواتير",
  dineIn: "من المستودع",

  startHint: "ابدأ باستيراد موادك وأسعارها من ملف Excel (من صفحة مخزون المنتجات)، ثم اربط مخزونك بسوق WENZDES.",
};

export const TERMS: Record<BusinessType, Terms> = { restaurant, cafe, shop, supplier };

export const TERM_KEYS = Object.keys(restaurant) as (keyof Terms)[];

export function termsFor(type: BusinessType): Terms {
  return TERMS[type];
}

/**
 * The type whose words apply. The owner's saved choice wins. An install that never chose keeps what it always
 * showed: no kitchen = a shop's words (a supplier's if this till's supplier switch is on), otherwise the restaurant's.
 */
export function termsType(saved: string | null | undefined, hasKitchen: boolean, supplierMode: boolean): BusinessType {
  if (saved === "restaurant" || saved === "cafe" || saved === "shop" || saved === "supplier") return saved;
  if (hasKitchen) return "restaurant";
  return supplierMode ? "supplier" : "shop";
}

/** The type in force, from the business store and this device's supplier switch. */
export function currentType(): BusinessType {
  const b = useBusinessStore.getState();
  return termsType(b.businessType, b.hasKitchen, usePrefsStore.getState().supplierMode);
}

/** Sidebar labels in the business's own words. */
export function labelNav(items: SidebarNavItem[], t: Terms): SidebarNavItem[] {
  const label: Record<string, string> = { pos: t.tillNav, orders: t.ordersNav, customers: t.customersNav, menu: t.menu, kds: t.kitchen, "ai-onboarding": t.menuSetupAi };
  return items.map((n) => (label[n.id] ? { ...n, label: label[n.id]! } : n));
}

/** The words for plain code (toasts, printing); components use `useTerms()`. */
export function getTerms(): Terms {
  return TERMS[currentType()];
}

/** The words for this business, re-read whenever the type, tables/kitchen or the supplier switch change. */
export function useTerms(): Terms {
  const businessType = useBusinessStore((s) => s.businessType);
  const hasKitchen = useBusinessStore((s) => s.hasKitchen);
  const supplierMode = usePrefsStore((s) => s.supplierMode);
  return TERMS[termsType(businessType, hasKitchen, supplierMode)];
}
