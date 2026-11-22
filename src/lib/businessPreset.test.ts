import { describe, it, expect } from "vitest";
import { navForMode, presetFromMode, presetToMode } from "./businessPreset";

const nav = ["pos", "kds", "menu", "debt", "inventory"].map((id) => ({ id, label: id, icon: "x", allowed: true }));

describe("business presets", () => {
  it("round-trips preset <-> mode", () => {
    expect(presetFromMode(presetToMode("restaurant"))).toBe("restaurant");
    expect(presetFromMode(presetToMode("retail"))).toBe("retail");
    expect(presetFromMode({ has_tables: false, has_kitchen: true })).toBe("custom");
  });

  it("retail hides KDS and keeps debt (the labels come from terms.ts)", () => {
    const items = navForMode(nav, presetToMode("retail"));
    expect(items.map((n) => n.id)).toEqual(["pos", "menu", "debt", "inventory"]);
  });

  it("restaurant shows everything unchanged", () => {
    expect(navForMode(nav, presetToMode("restaurant"))).toEqual(nav);
  });
});
