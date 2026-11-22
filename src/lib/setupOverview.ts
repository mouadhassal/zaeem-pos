// The read-only "setup overview" (Settings > نظرة عامة على الإعداد): the pure grouping and counting behind
// each section. No invoke, no DOM. Nothing here changes anything; every section links to the screen where
// the thing is edited.

export interface AreaLite {
  id: string;
  name: string;
  sort_order: number;
}

export interface TableLite {
  id: string;
  name: string;
  area_id?: string | null | undefined;
}

export interface AreaGroup {
  id: string | null;
  name: string;
  tables: TableLite[];
}

/** Areas with their tables, in the owner's order; tables with no area (or a deleted one) come last. */
export function areaGroups(areas: AreaLite[], tables: TableLite[]): AreaGroup[] {
  const known = new Set(areas.map((a) => a.id));
  const sorted = [...areas].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ar"));
  const groups: AreaGroup[] = sorted.map((a) => ({ id: a.id, name: a.name, tables: tables.filter((t) => t.area_id === a.id) }));
  const loose = tables.filter((t) => !t.area_id || !known.has(t.area_id));
  if (loose.length > 0) groups.push({ id: null, name: areas.length > 0 ? "بدون صالة" : "الطاولات", tables: loose });
  return groups;
}

export interface CategoryLite {
  id: string;
  name: string;
  is_active: number;
  cost_class: string | null;
  sort_order: number;
}

export interface ItemLite {
  id: string;
  name: string;
  category_id: string;
  cost_cents: number;
  is_active: number;
  is_combo: number;
}

export interface CategorySummary {
  id: string;
  name: string;
  /** FOOD, BEVERAGE, SHISHA or OTHER (no class reads as FOOD). */
  costClass: string;
  itemCount: number;
  /** Active items with no cost price: the profit of what they sell cannot be worked out. */
  withoutCost: string[];
}

/** Categories with the number of items in each and the items that have no cost price entered. */
export function categorySummaries(categories: CategoryLite[], items: ItemLite[]): CategorySummary[] {
  return [...categories]
    .filter((c) => c.is_active !== 0)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ar"))
    .map((c) => {
      const mine = items.filter((i) => i.category_id === c.id && i.is_active !== 0);
      return {
        id: c.id,
        name: c.name,
        costClass: c.cost_class || "FOOD",
        itemCount: mine.length,
        withoutCost: mine.filter((i) => i.is_combo === 0 && i.cost_cents <= 0).map((i) => i.name),
      };
    });
}

export function countWithoutCost(summaries: CategorySummary[]): number {
  return summaries.reduce((s, c) => s + c.withoutCost.length, 0);
}

export interface CategorySalesRow {
  name: string;
  revenue_cents: number;
  /** Share of all category sales, percent with one decimal. */
  pct: number;
}

/** This month's sales per category, biggest first, with each one's share of the total. */
export function categorySales(rows: { name: string; revenue_cents: number }[]): CategorySalesRow[] {
  const total = rows.reduce((s, r) => s + Math.max(0, r.revenue_cents), 0);
  return [...rows]
    .filter((r) => r.revenue_cents > 0)
    .sort((a, b) => b.revenue_cents - a.revenue_cents)
    .map((r) => ({ name: r.name, revenue_cents: r.revenue_cents, pct: total > 0 ? Math.round((r.revenue_cents / total) * 1000) / 10 : 0 }));
}

// ---------------------------------------------------------------- who can open what

export interface FeatureLite {
  key: string;
  onlyRoles?: string[] | undefined;
}

export interface RoleCellLite {
  role: string;
  feature: string;
  allowed: boolean;
}

export interface PersonCellLite {
  feature: string;
  allowed: boolean | null;
}

/** The roles of the owner's table; a "SERVER" works like a cashier. */
export function accessRole(role: string): string {
  return role === "SERVER" ? "CASHIER" : role;
}

export interface AccessAnswer {
  /** null = does not apply (a box that role does not have, or a role the table does not cover). */
  allowed: boolean | null;
  /** The person has their own exception here instead of what their role says. */
  exception: boolean;
}

/** What one person may do in one box: their own exception first, else their role's box; the owner may do everything. */
export function accessOf(role: string, feature: FeatureLite, matrix: RoleCellLite[], person: PersonCellLite[] | undefined): AccessAnswer {
  if (role === "OWNER") return { allowed: true, exception: false };
  const r = accessRole(role);
  if (feature.onlyRoles && !feature.onlyRoles.includes(r)) return { allowed: null, exception: false };
  const own = person?.find((c) => c.feature === feature.key)?.allowed;
  if (own !== null && own !== undefined) return { allowed: own, exception: true };
  const cell = matrix.find((c) => c.role === r && c.feature === feature.key);
  return { allowed: cell ? cell.allowed : null, exception: false };
}
