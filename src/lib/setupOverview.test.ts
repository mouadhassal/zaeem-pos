import { describe, expect, it } from "vitest";
import { accessOf, accessRole, areaGroups, categorySales, categorySummaries, countWithoutCost } from "./setupOverview";

describe("areas and tables", () => {
  const areas = [
    { id: "a2", name: "التراس", sort_order: 2 },
    { id: "a1", name: "الصالة", sort_order: 1 },
  ];
  it("lists each area with its tables, in the owner's order", () => {
    const g = areaGroups(areas, [{ id: "t1", name: "1", area_id: "a1" }, { id: "t2", name: "2", area_id: "a2" }, { id: "t3", name: "3", area_id: "a1" }]);
    expect(g.map((x) => [x.name, x.tables.map((t) => t.id)])).toEqual([["الصالة", ["t1", "t3"]], ["التراس", ["t2"]]]);
  });
  it("puts tables with no area, or a deleted one, in a last group", () => {
    const g = areaGroups(areas, [{ id: "t1", name: "1" }, { id: "t2", name: "2", area_id: "gone" }]);
    expect(g[g.length - 1]).toEqual({ id: null, name: "بدون صالة", tables: [{ id: "t1", name: "1" }, { id: "t2", name: "2", area_id: "gone" }] });
  });
  it("a shop with no areas has one plain group of tables, or none", () => {
    expect(areaGroups([], [{ id: "t1", name: "1" }]).map((x) => x.name)).toEqual(["الطاولات"]);
    expect(areaGroups([], [])).toEqual([]);
  });
});

describe("categories and items", () => {
  const cats = [
    { id: "c2", name: "مشروبات", is_active: 1, cost_class: "BEVERAGE", sort_order: 2 },
    { id: "c1", name: "وجبات", is_active: 1, cost_class: null, sort_order: 1 },
    { id: "c3", name: "قديم", is_active: 0, cost_class: null, sort_order: 3 },
  ];
  const items = [
    { id: "i1", name: "برغر", category_id: "c1", cost_cents: 40, is_active: 1, is_combo: 0 },
    { id: "i2", name: "بيتزا", category_id: "c1", cost_cents: 0, is_active: 1, is_combo: 0 },
    { id: "i3", name: "وجبة عائلية", category_id: "c1", cost_cents: 0, is_active: 1, is_combo: 1 },
    { id: "i4", name: "شاي", category_id: "c2", cost_cents: 3, is_active: 1, is_combo: 0 },
    { id: "i5", name: "موقوف", category_id: "c2", cost_cents: 0, is_active: 0, is_combo: 0 },
  ];
  it("counts items, reads a missing class as food and drops closed categories", () => {
    const s = categorySummaries(cats, items);
    expect(s.map((c) => [c.name, c.costClass, c.itemCount])).toEqual([["وجبات", "FOOD", 3], ["مشروبات", "BEVERAGE", 1]]);
  });
  it("flags active items with no cost price, but not combos or stopped items", () => {
    const s = categorySummaries(cats, items);
    expect(s[0]!.withoutCost).toEqual(["بيتزا"]);
    expect(s[1]!.withoutCost).toEqual([]);
    expect(countWithoutCost(s)).toBe(1);
  });
});

describe("sales by category", () => {
  it("sorts biggest first with each one's share, leaving out categories with no sales", () => {
    const rows = categorySales([
      { name: "مشروبات", revenue_cents: 250 },
      { name: "وجبات", revenue_cents: 750 },
      { name: "حلويات", revenue_cents: 0 },
    ]);
    expect(rows).toEqual([{ name: "وجبات", revenue_cents: 750, pct: 75 }, { name: "مشروبات", revenue_cents: 250, pct: 25 }]);
    expect(categorySales([])).toEqual([]);
  });
});

describe("who can open what", () => {
  const matrix = [
    { role: "MANAGER", feature: "finance", allowed: false },
    { role: "MANAGER", feature: "reports", allowed: true },
    { role: "CASHIER", feature: "reports", allowed: false },
    { role: "MANAGER", feature: "workers", allowed: true },
  ];
  const reports = { key: "reports" };
  const finance = { key: "finance" };
  const workers = { key: "workers", onlyRoles: ["MANAGER"] };
  it("follows the role's box", () => {
    expect(accessOf("MANAGER", reports, matrix, undefined)).toEqual({ allowed: true, exception: false });
    expect(accessOf("CASHIER", reports, matrix, undefined)).toEqual({ allowed: false, exception: false });
    expect(accessOf("MANAGER", finance, matrix, undefined).allowed).toBe(false);
  });
  it("a person's own exception wins, and is marked", () => {
    expect(accessOf("CASHIER", reports, matrix, [{ feature: "reports", allowed: true }])).toEqual({ allowed: true, exception: true });
    expect(accessOf("MANAGER", reports, matrix, [{ feature: "reports", allowed: null }])).toEqual({ allowed: true, exception: false });
  });
  it("the owner may do everything", () => {
    expect(accessOf("OWNER", finance, matrix, undefined)).toEqual({ allowed: true, exception: false });
  });
  it("boxes a role does not have, and roles the table does not cover, do not apply", () => {
    expect(accessOf("CASHIER", workers, matrix, undefined).allowed).toBeNull();
    expect(accessOf("ACCOUNTANT", reports, matrix, undefined).allowed).toBeNull();
  });
  it("a server works like a cashier", () => {
    expect(accessRole("SERVER")).toBe("CASHIER");
    expect(accessOf("SERVER", reports, matrix, undefined).allowed).toBe(false);
  });
});
