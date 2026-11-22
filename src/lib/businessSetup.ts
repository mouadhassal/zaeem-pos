// What choosing a type of business sets up: the setup wizard's first question and Settings > نوع النشاط.
// One pure plan per type (testable), and one function that writes it (wizard and Settings share it).
import { invoke } from "./invoke";
import { PRODUCTS_PER_ROW_AUTO } from "./menuGridLayout";
import { MODULE_INFO, MODULE_KEYS, TYPE_PRESETS, type BusinessType, type ModuleKey } from "./businessModules";
import { TERMS, type Terms } from "./terms";

export interface SetupPlan {
  type: BusinessType;
  /** chain_config switches. */
  hasTables: boolean;
  hasKitchen: boolean;
  /** business_profile modules. */
  modules: Record<ModuleKey, boolean>;
  /** This till is a supplier's (the marketplace link is front and centre). */
  supplierMode: boolean;
  /** Per-device till defaults: item cards per row (0 = auto). A shop's catalogue is long, so denser cards. */
  productsPerRow: number;
  /** Tables to create when the setup wizard finishes (0 = none). */
  seedTables: number;
}

export function setupPlan(type: BusinessType): SetupPlan {
  const preset = TYPE_PRESETS[type];
  return {
    type,
    hasTables: preset.tables,
    hasKitchen: preset.kitchen,
    modules: { ...preset.modules },
    supplierMode: type === "supplier",
    productsPerRow: preset.tables ? PRODUCTS_PER_ROW_AUTO : 6,
    seedTables: preset.tables ? 8 : 0,
  };
}

/** The four big cards of the wizard's first question: what each type gets, in one line. */
export const TYPE_CARDS: { id: BusinessType; label: string; gets: string }[] = [
  { id: "restaurant", label: "مطعم", gets: "طاولات وتذاكر مطبخ وإضافات على الأصناف، مع التوصيل والاستلام" },
  { id: "cafe", label: "مقهى", gets: "طاولات وتحضير سريع، مع العروض وساعة السعادة" },
  { id: "shop", label: "متجر / بقالة", gets: "باركود أولاً وبيع سريع، مع دفتر الديون ومخزون المنتجات" },
  { id: "supplier", label: "مورّد / جملة", gets: "قائمة أسعار وعملاء تجار، ومخزونك مربوط بسوق WENZDES" },
];

/** What changes if the owner switches from one type to another: modules turned on/off and the words that differ. */
export interface TypeChange {
  modulesOn: string[];
  modulesOff: string[];
  tables: "on" | "off" | null;
  kitchen: "on" | "off" | null;
  words: { what: string; from: string; to: string }[];
}

const WORD_ROWS: { what: string; key: keyof Terms }[] = [
  { what: "القائمة", key: "menu" },
  { what: "الصنف", key: "item" },
  { what: "الزبون", key: "customer" },
  { what: "سجل الطلبات", key: "ordersNav" },
  { what: "المكان", key: "place" },
];

export function describeChange(
  from: { tables: boolean; kitchen: boolean; modules: Record<ModuleKey, boolean> },
  to: BusinessType,
  fromTerms: Terms,
): TypeChange {
  const plan = setupPlan(to);
  const label = (k: "tables" | "kitchen" | ModuleKey) => MODULE_INFO.find((m) => m.key === k)?.label ?? k;
  const modulesOn: string[] = [];
  const modulesOff: string[] = [];
  for (const k of MODULE_KEYS) {
    if (plan.modules[k] && !from.modules[k]) modulesOn.push(label(k));
    if (!plan.modules[k] && from.modules[k]) modulesOff.push(label(k));
  }
  const toTerms = TERMS[to];
  return {
    modulesOn,
    modulesOff,
    tables: plan.hasTables === from.tables ? null : plan.hasTables ? "on" : "off",
    kitchen: plan.hasKitchen === from.kitchen ? null : plan.hasKitchen ? "on" : "off",
    words: WORD_ROWS.map((r) => ({ what: r.what, from: fromTerms[r.key], to: toTerms[r.key] })).filter((w) => w.from !== w.to),
  };
}

/**
 * Writes a plan: the business profile first, then tables/kitchen (the last call ends the setup window of a brand-new
 * install, so everything else must come before it), then this device's till defaults. `seedTables` names the tables
 * to create first (wizard only: a new restaurant must not open with nothing to seat a customer at).
 */
export async function applyPlan(
  plan: SetupPlan,
  io: {
    token: string | null;
    seedTables?: boolean;
    saveProfile: (type: string, modules: Record<string, boolean>) => Promise<void>;
    setSupplierMode: (on: boolean) => void;
    setProductsPerRow: (n: number) => void;
  },
): Promise<void> {
  const sessionToken = io.token;
  if (io.seedTables && plan.seedTables > 0) {
    const existing = await invoke<{ name: string }[]>("list_tables_v3", { sessionToken });
    if (existing.length <= 1) {
      for (let n = 1; n <= plan.seedTables; n++) await invoke("create_table_v3", { sessionToken, name: String(n), branchId: null });
    }
  }
  await io.saveProfile(plan.type, plan.modules);
  await invoke("update_business_mode_v3", { sessionToken, hasTables: plan.hasTables, hasKitchen: plan.hasKitchen });
  io.setSupplierMode(plan.supplierMode);
  io.setProductsPerRow(plan.productsPerRow);
}

/**
 * The screen a person starts on after signing in. The kitchen role starts at its screen; everyone else at the till
 * (tables for a restaurant or café, the barcode till for a shop, the same till with price-list words for a supplier).
 * An owner who never chose a type keeps the dashboard, as before; once a type is chosen the till is the starting point
 * (POS Lite has no dashboard at all).
 */
export function landingView(role: string | undefined, businessType: string | null, posLite: boolean): string {
  if (role === "KITCHEN") return "kds";
  if (role === "OWNER" && !posLite && !businessType) return "dashboard";
  return "pos";
}
