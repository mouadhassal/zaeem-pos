// Setup presets on top of chain_config's has_tables/has_kitchen switches.
import type { SidebarNavItem } from "./permissions";

export type BusinessPreset = "restaurant" | "retail" | "supplier";

export interface ModeFlags {
  has_tables: boolean;
  has_kitchen: boolean;
}

/** A supplier is a shop (no tables, no kitchen) that is also linked to the marketplace; the flags are the shop's. */
export function presetToMode(preset: BusinessPreset): ModeFlags {
  return preset === "restaurant" ? { has_tables: true, has_kitchen: true } : { has_tables: false, has_kitchen: false };
}

export function presetFromMode(mode: ModeFlags): BusinessPreset | "custom" {
  if (mode.has_tables && mode.has_kitchen) return "restaurant";
  if (!mode.has_tables && !mode.has_kitchen) return "retail";
  return "custom";
}

// Hides the kitchen page when there is no kitchen. The labels (القائمة / المنتجات / ...) come from lib/terms.ts.
export function navForMode(items: SidebarNavItem[], mode: ModeFlags): SidebarNavItem[] {
  return items.filter((n) => mode.has_kitchen || n.id !== "kds");
}
