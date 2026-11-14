// One app for a restaurant, a café, a shop and a supplier. The owner picks the type (it only sets a
// starting set of modules), then switches any module on or off (Settings > نوع النشاط والوحدات).
// Tables and the kitchen are the old chain_config switches; the rest live in business_profile
// (src-tauri/src/business.rs), which also refuses the commands of a module that is off.
import type { SidebarNavItem } from "./permissions";

export type BusinessType = "restaurant" | "cafe" | "shop" | "supplier";

/** Module keys of business.rs `MODULES` (tables and kitchen are handled separately). */
export type ModuleKey = "delivery" | "pickup" | "debt" | "loyalty" | "inventory" | "marketplace" | "offers" | "hr" | "ai";

export const MODULE_KEYS: ModuleKey[] = ["delivery", "pickup", "debt", "loyalty", "inventory", "marketplace", "offers", "hr", "ai"];

export const BUSINESS_TYPES: { id: BusinessType; label: string; hint: string }[] = [
  { id: "restaurant", label: "مطعم", hint: "طاولات، مطبخ وتذاكر أقسام، إضافات، توصيل واستلام" },
  { id: "cafe", label: "مقهى", hint: "مثل المطعم: طاولات وتحضير وإضافات، وعروض وساعة سعادة" },
  { id: "shop", label: "متجر / بقالة", hint: "باركود أولاً، دفع سريع، دفتر ديون ومخزون، بدون طاولات ومطبخ" },
  { id: "supplier", label: "مورّد / جملة", hint: "مثل المتجر، ومخزونك مربوط بسوق WENZDES وطلبات عملائك التجار" },
];

export const MODULE_INFO: { key: "tables" | "kitchen" | ModuleKey; label: string; hint: string }[] = [
  { key: "tables", label: "الطاولات", hint: "اختيار الطاولة، دمج ونقل وتقسيم الحساب" },
  { key: "kitchen", label: "المطبخ والإضافات", hint: "تذاكر الأقسام وشاشة المطبخ" },
  { key: "delivery", label: "التوصيل والسائقون", hint: "طلبات التوصيل، السائقون وكشوفهم" },
  { key: "pickup", label: "طلبات الاستلام", hint: "طلب هاتفي يُدفع عند الحضور" },
  { key: "debt", label: "دفتر الديون", hint: "البيع بالدين وتسديد الديون" },
  { key: "loyalty", label: "برنامج الولاء", hint: "بطاقات النقاط والمكافآت" },
  { key: "inventory", label: "المواد والموردون", hint: "المواد الخام والوصفات والموردون وأوامر الشراء" },
  { key: "marketplace", label: "سوق WENZDES", hint: "الشراء من الموردين وبيع بضاعتك للمحلات" },
  { key: "offers", label: "العروض وساعة السعادة", hint: "الوجبات المجمّعة والخصم بالساعة" },
  { key: "hr", label: "الحضور والرواتب", hint: "البصمة، جدول الدوام، الرواتب والسلف" },
  { key: "ai", label: "الذكاء الاصطناعي", hint: "المساعد الذكي وإعداد القائمة بالصور" },
];

export interface TypePreset {
  tables: boolean;
  kitchen: boolean;
  modules: Record<ModuleKey, boolean>;
}

const ALL_ON: Record<ModuleKey, boolean> = { delivery: true, pickup: true, debt: true, loyalty: true, inventory: true, marketplace: true, offers: true, hr: true, ai: true };

/** The starting modules of each type (the plan's table, 2026-11-14). */
export const TYPE_PRESETS: Record<BusinessType, TypePreset> = {
  restaurant: { tables: true, kitchen: true, modules: { ...ALL_ON, marketplace: false } },
  cafe: { tables: true, kitchen: true, modules: { ...ALL_ON, marketplace: false } },
  shop: { tables: false, kitchen: false, modules: { ...ALL_ON, delivery: false, pickup: false, marketplace: false, offers: false } },
  supplier: { tables: false, kitchen: false, modules: { ...ALL_ON, pickup: false, loyalty: false, offers: false } },
};

/** Which module a sidebar page belongs to. Pages not listed are never switched off by a module. */
export const PAGE_MODULE: Record<string, ModuleKey> = {
  delivery: "delivery",
  debt: "debt",
  loyalty: "loyalty",
  inventory: "inventory",
  marketplace: "marketplace",
  schedule: "hr",
  payroll: "hr",
  ai: "ai",
  "ai-onboarding": "ai",
};

/** The sidebar without the pages of switched-off modules. `null` (not loaded yet) = everything. */
export function applyModules(nav: SidebarNavItem[], modules: Record<string, boolean> | null | undefined): SidebarNavItem[] {
  if (!modules) return nav;
  return nav.filter((n) => {
    const m = PAGE_MODULE[n.id];
    return m === undefined || modules[m] !== false;
  });
}

/** Whether a module is on; unknown (not loaded) counts as on, like the server. */
export function moduleOn(modules: Record<string, boolean> | null | undefined, key: ModuleKey): boolean {
  return !modules || modules[key] !== false;
}

/** The type to show when the owner never chose one: worked out from tables/kitchen (and supplier mode). */
export function inferType(saved: string | null | undefined, mode: { has_tables: boolean; has_kitchen: boolean }, supplierMode: boolean): BusinessType {
  if (saved === "restaurant" || saved === "cafe" || saved === "shop" || saved === "supplier") return saved;
  if (mode.has_tables || mode.has_kitchen) return "restaurant";
  return supplierMode ? "supplier" : "shop";
}
