import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("./invoke", () => ({
  invoke: vi.fn(async (name: string, args?: Record<string, unknown>) => {
    calls.push(name === "create_table_v3" ? `table:${args?.name}` : name === "update_business_mode_v3" ? `mode:${args?.hasTables}/${args?.hasKitchen}` : name);
    return name === "list_tables_v3" ? [{ name: "counter" }] : undefined;
  }),
}));

import { TYPE_CARDS, applyPlan, describeChange, landingView, setupPlan } from "./businessSetup";
import { MODULE_KEYS, TYPE_PRESETS, type BusinessType, type ModuleKey } from "./businessModules";
import { TERMS } from "./terms";

const TYPES: BusinessType[] = ["restaurant", "cafe", "shop", "supplier"];

describe("choosing a type of business", () => {
  it("offers the four types, each with a one-line description", () => {
    expect(TYPE_CARDS.map((c) => c.id)).toEqual(TYPES);
    for (const c of TYPE_CARDS) expect(c.gets.length).toBeGreaterThan(10);
  });

  it("maps every type to its preset modules, tables/kitchen and till defaults", () => {
    for (const t of TYPES) {
      const p = setupPlan(t);
      expect(p.modules).toEqual(TYPE_PRESETS[t].modules);
      expect(p.hasTables).toBe(TYPE_PRESETS[t].tables);
      expect(p.hasKitchen).toBe(TYPE_PRESETS[t].kitchen);
      expect(Object.keys(p.modules).sort()).toEqual([...MODULE_KEYS].sort());
    }
    expect(setupPlan("restaurant")).toMatchObject({ hasTables: true, hasKitchen: true, supplierMode: false, productsPerRow: 0, seedTables: 8 });
    expect(setupPlan("cafe")).toMatchObject({ hasTables: true, supplierMode: false, seedTables: 8 });
    expect(setupPlan("shop")).toMatchObject({ hasTables: false, hasKitchen: false, supplierMode: false, productsPerRow: 6, seedTables: 0 });
    expect(setupPlan("supplier")).toMatchObject({ hasTables: false, hasKitchen: false, supplierMode: true, productsPerRow: 6, seedTables: 0 });
    expect(setupPlan("supplier").modules.marketplace).toBe(true);
    expect(setupPlan("shop").modules.pickup).toBe(false);
  });

  it("only restaurants and cafes get tables; the others get no dine-in", () => {
    expect(TYPES.filter((t) => setupPlan(t).seedTables > 0)).toEqual(["restaurant", "cafe"]);
  });
});

describe("applyPlan", () => {
  beforeEach(() => { calls.length = 0; });
  const io = () => ({
    token: "t",
    seedTables: true,
    saveProfile: async (type: string) => { calls.push(`profile:${type}`); },
    setSupplierMode: (on: boolean) => { calls.push(`supplier:${on}`); },
    setProductsPerRow: (n: number) => { calls.push(`perRow:${n}`); },
  });

  it("a restaurant: tables first, then the profile, then the mode (which ends the setup window)", async () => {
    await applyPlan(setupPlan("restaurant"), io());
    expect(calls[0]).toBe("list_tables_v3");
    expect(calls.filter((c) => c.startsWith("table:")).length).toBe(8);
    expect(calls.indexOf("profile:restaurant")).toBeGreaterThan(calls.lastIndexOf("table:8"));
    expect(calls.indexOf("mode:true/true")).toBeGreaterThan(calls.indexOf("profile:restaurant"));
    expect(calls).toContain("supplier:false");
  });

  it("a supplier: no tables, supplier switch on, denser cards", async () => {
    await applyPlan(setupPlan("supplier"), io());
    expect(calls.some((c) => c.startsWith("table:") || c === "list_tables_v3")).toBe(false);
    expect(calls).toEqual(expect.arrayContaining(["profile:supplier", "mode:false/false", "supplier:true", "perRow:6"]));
  });

  it("Settings does not seed tables", async () => {
    await applyPlan(setupPlan("cafe"), { ...io(), seedTables: false });
    expect(calls.some((c) => c.startsWith("table:"))).toBe(false);
  });
});

describe("what a switch of type changes", () => {
  const all = (on: boolean) => Object.fromEntries(MODULE_KEYS.map((k) => [k, on])) as Record<ModuleKey, boolean>;

  it("restaurant to supplier: modules, tables, kitchen and words", () => {
    const from = { tables: true, kitchen: true, modules: { ...all(true), marketplace: false } };
    const c = describeChange(from, "supplier", TERMS.restaurant);
    expect(c.modulesOn).toEqual(["سوق WENZDES"]);
    expect(c.modulesOff).toEqual(expect.arrayContaining(["طلبات الاستلام", "برنامج الولاء", "العروض وساعة السعادة"]));
    expect(c.tables).toBe("off");
    expect(c.kitchen).toBe("off");
    expect(c.words.find((w) => w.what === "القائمة")).toEqual({ what: "القائمة", from: "القائمة", to: "قائمة الأسعار" });
    expect(c.words.find((w) => w.what === "الزبون")?.to).toBe("عميل تاجر");
  });

  it("same type: nothing changes", () => {
    const p = setupPlan("shop");
    const c = describeChange({ tables: false, kitchen: false, modules: p.modules }, "shop", TERMS.shop);
    expect(c).toEqual({ modulesOn: [], modulesOff: [], tables: null, kitchen: null, words: [] });
  });
});

describe("landing page", () => {
  it("follows the type; the kitchen role keeps its screen", () => {
    expect(landingView("KITCHEN", "restaurant", false)).toBe("kds");
    expect(landingView("CASHIER", null, false)).toBe("pos");
    for (const t of TYPES) expect(landingView("OWNER", t, false)).toBe("pos");
    expect(landingView("OWNER", null, false)).toBe("dashboard");
    expect(landingView("OWNER", null, true)).toBe("pos");
  });
});
