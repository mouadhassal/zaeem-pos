// Setup presets on top of chain_config's has_tables/has_kitchen switches.
import type { SidebarNavItem } from "./permissions";

export type BusinessPreset = "restaurant" | "retail";

export interface ModeFlags {
  has_tables: boolean;
  has_kitchen: boolean;
}

export const PRESETS: { id: BusinessPreset; label: string; hint: string }[] = [
  { id: "restaurant", label: "مطعم / مقهى", hint: "طاولات، تذاكر مطبخ، إضافات على الأصناف" },
  { id: "retail", label: "بقالة / متجر", hint: "باركود أولاً، دفع سريع، دفتر ديون -- بدون طاولات أو شاشة مطبخ" },
];

export function presetToMode(preset: BusinessPreset): ModeFlags {
  return preset === "restaurant" ? { has_tables: true, has_kitchen: true } : { has_tables: false, has_kitchen: false };
}

export function presetFromMode(mode: ModeFlags): BusinessPreset | "custom" {
  if (mode.has_tables && mode.has_kitchen) return "restaurant";
  if (!mode.has_tables && !mode.has_kitchen) return "retail";
  return "custom";
}

// Hides kitchen-only pages and swaps food-service labels for non-kitchen shops.
export function navForMode(items: SidebarNavItem[], mode: ModeFlags): SidebarNavItem[] {
  return items
    .filter((n) => mode.has_kitchen || n.id !== "kds")
    .map((n) => {
      if (mode.has_kitchen) return n;
      if (n.id === "menu") return { ...n, label: "المنتجات" };
      if (n.id === "ai-onboarding") return { ...n, label: "إعداد المنتجات AI" };
      return n;
    });
}
