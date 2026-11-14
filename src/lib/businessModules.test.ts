import { describe, expect, it } from "vitest";
import { MODULE_KEYS, TYPE_PRESETS, applyModules, inferType, moduleOn } from "./businessModules";

const nav = ["pos", "delivery", "debt", "payroll", "schedule", "ai", "menu"].map((id) => ({ id, label: id, icon: "x", allowed: true }));

describe("business modules", () => {
  it("a switched-off module takes its pages with it; nothing loaded = everything", () => {
    expect(applyModules(nav, null).map((n) => n.id)).toEqual(nav.map((n) => n.id));
    const ids = applyModules(nav, { delivery: false, hr: false }).map((n) => n.id);
    expect(ids).toEqual(["pos", "debt", "ai", "menu"]);
  });
  it("unknown counts as on, like the server", () => {
    expect(moduleOn(null, "debt")).toBe(true);
    expect(moduleOn({ debt: false }, "debt")).toBe(false);
    expect(moduleOn({}, "debt")).toBe(true);
  });
  it("every type has every module and the plan's shape", () => {
    for (const p of Object.values(TYPE_PRESETS)) expect(Object.keys(p.modules).sort()).toEqual([...MODULE_KEYS].sort());
    expect(TYPE_PRESETS.restaurant).toMatchObject({ tables: true, kitchen: true });
    expect(TYPE_PRESETS.shop).toMatchObject({ tables: false, kitchen: false, modules: { pickup: false, debt: true } });
    expect(TYPE_PRESETS.supplier.modules.marketplace).toBe(true);
    expect(TYPE_PRESETS.restaurant.modules.marketplace).toBe(false);
  });
  it("the type shown before the owner chose one follows tables/kitchen", () => {
    expect(inferType(null, { has_tables: true, has_kitchen: true }, false)).toBe("restaurant");
    expect(inferType(null, { has_tables: false, has_kitchen: false }, false)).toBe("shop");
    expect(inferType(null, { has_tables: false, has_kitchen: false }, true)).toBe("supplier");
    expect(inferType("cafe", { has_tables: false, has_kitchen: false }, false)).toBe("cafe");
  });
});
